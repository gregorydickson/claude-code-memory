/**
 * Shared base class for FalkorDB and FalkorDBLite backends.
 *
 * Both backends use the same graph query engine and Cypher dialect.
 * The only differences are connection setup (client-server vs embedded)
 * and health-check metadata. This module extracts the shared logic.
 */

import { randomUUID } from "node:crypto";

import { Config } from "../config.js";
import {
  type Memory,
  type Relationship,
  type RelationshipProperties,
  type SearchQuery,
  memoryToNodeProperties,
  createRelationshipProperties,
  clearedMemoryProperties,
  toIso,
  ALL_RELATIONSHIP_TYPES,
} from "../models.js";
import {
  type GraphBackend,
  type HealthCheckResult,
} from "./base.js";
import {
  DatabaseConnectionError,
  RelationshipError,
  ValidationError,
} from "../errors.js";
import { parseMemoryFromProperties } from "../utils/memory-parser.js";

/** Maximum traversal depth for relationship queries. */
const MAX_TRAVERSAL_DEPTH = 10;

/** Validate that a relationship type is safe for Cypher interpolation. */
function validateRelType(relType: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(relType)) {
    throw new ValidationError(
      `Invalid relationship type: '${relType}'. Only alphanumeric and underscore allowed.`
    );
  }
}

export abstract class BaseFalkorDBBackend implements GraphBackend {
  abstract _display_name: string;

  graphName: string;
  client: any = null;
  graph: any = null;
  _connected = false;
  private _schemaInitialized = false;

  constructor(graphName = "memorygraph") {
    this.graphName = graphName;
  }

  // -----------------------------------------------------------------------
  // Abstract methods (must be implemented by subclasses)
  // -----------------------------------------------------------------------

  abstract connect(): Promise<boolean>;
  abstract healthCheck(): Promise<HealthCheckResult>;
  abstract backendName(): string;

  // -----------------------------------------------------------------------
  // Connection lifecycle (shared)
  // -----------------------------------------------------------------------

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        if (typeof this.client.close === "function") {
          await this.client.close();
        } else if (typeof this.client.disconnect === "function") {
          await this.client.disconnect();
        }
      } catch {
        // best-effort close
      }
    }
    this.client = null;
    this.graph = null;
    this._connected = false;
    // A later connect() may target a recreated graph (or a freshly wiped
    // database), so schema state must not be carried across connections.
    this._schemaInitialized = false;
    console.log(`${this._display_name} connection closed`);
  }

  // -----------------------------------------------------------------------
  // Query execution
  // -----------------------------------------------------------------------

  async executeQuery(
    query: string,
    parameters?: Record<string, unknown>,
    _write = false
  ): Promise<Record<string, unknown>[]> {
    if (!this._connected || !this.graph) {
      throw new DatabaseConnectionError(
        `Connection failed: not connected to ${this._display_name} (call connect() first)`
      );
    }

    const params = sanitizeParams(parameters ?? {});

    try {
      // FalkorDB JS client expects query options (incl. params) as the
      // second argument and passes params inline via CYPHER, e.g.
      // `options: { params: { ... } }`. Passing params positionally
      // results in "Missing parameters" errors. `null`/`undefined` values
      // inside object params must be dropped — the inline serializer
      // otherwise fails with "Encountered unhandled type".
      const result = await this.graph.query(query, { params });
      return this.convertFalkorDBResult(result);
    } catch (err) {
      console.error(`Query execution failed: ${err}`);
      throw new DatabaseConnectionError(`Query execution failed: ${err}`);
    }
  }

  private convertFalkorDBResult(result: any): Record<string, unknown>[] {
    const resultList: Record<string, unknown>[] = [];
    if (!result) return resultList;

    // FalkorDB JS client returns { data: [...], header: [...] }
    const resultSet = result.data ?? result.result_set ?? result;
    if (!Array.isArray(resultSet)) return resultList;

    // Get column names from header
    let columnNames: string[] = [];
    if (result.header) {
      columnNames = result.header.map((h: any) => {
        if (Array.isArray(h) && h.length >= 2) return h[1];
        return String(h);
      });
    }

    for (const row of resultSet) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        // Already a dict-like object
        resultList.push(this.convertFalkorDBValue(row));
      } else if (Array.isArray(row) && columnNames.length > 0) {
        const record: Record<string, unknown> = {};
        for (let i = 0; i < row.length && i < columnNames.length; i++) {
          record[columnNames[i]] = this.convertFalkorDBValue(row[i]);
        }
        resultList.push(record);
      } else {
        resultList.push(row);
      }
    }

    return resultList;
  }

  private convertFalkorDBValue(value: any): any {
    if (Array.isArray(value)) {
      return value.map((v) => this.convertFalkorDBValue(v));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // FalkorDB node: { id, labels, properties: { ... } } → flatten properties.
      // Only unwrap a genuine node shape (identified by the `labels` marker and
      // a non-null, non-array `properties` map) so a result row that merely has
      // a column named `properties` does not collapse the whole row into it.
      if (
        Array.isArray(value["labels"]) &&
        "properties" in value &&
        value["properties"] !== null &&
        typeof value["properties"] === "object" &&
        !Array.isArray(value["properties"])
      ) {
        return { ...value.properties };
      }
      if (!(value instanceof Date)) {
        const out: Record<string, unknown> = {};
        let changed = false;
        for (const [k, v] of Object.entries(value)) {
          const converted = this.convertFalkorDBValue(v);
          if (converted !== v) changed = true;
          out[k] = converted;
        }
        return changed ? out : value;
      }
    }
    return value;
  }

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  async initializeSchema(): Promise<void> {
    if (this._schemaInitialized) {
      return;
    }

    const indexProps = ["type", "created_at", "importance", "confidence"];

    if (Config.isMultiTenantMode()) {
      indexProps.push(
        "context_tenant_id",
        "context_team_id",
        "context_visibility",
        "context_created_by",
        "version"
      );
    }

    // If the schema (range index on Memory.id plus the required per-property
    // indexes) already exists, the database was initialized on a previous
    // run. Skip schema creation entirely so opening an existing, populated
    // database is a no-op instead of re-issuing DDL on every process start.
    if ((await this.schemaExists(indexProps)) === true) {
      this._schemaInitialized = true;
      return;
    }

    console.log(`Initializing ${this._display_name} schema...`);

    // FalkorDB (client-server and embedded lite) rejects the legacy
    // `CREATE CONSTRAINT ON…` / `CREATE INDEX ON :...` Cypher strings, so the
    // schema is created through the client's supported index/constraint
    // helpers. Duplicate creation is not idempotent, so "already exists"
    // errors from raced partial schema state are treated as success, but any
    // genuine failure is still surfaced (not silently swallowed). Because both
    // FalkorDB and FalkorDBLite expose these helpers on their `Graph` object,
    // no divergent Cypher fallback is needed or supported.
    if (!this.graph || typeof this.graph.createNodeRangeIndex !== "function") {
      throw new DatabaseConnectionError(
        `${this._display_name} graph does not support schema index creation`
      );
    }

    // Supporting per-property range indexes. A genuine (non-duplicate) failure
    // must fail initialization so the schema is not silently marked present
    // while an index is actually missing.
    for (const prop of indexProps) {
      try {
        await this.graph.createNodeRangeIndex("Memory", [prop]);
      } catch (err) {
        if (!isAlreadyExistsError(err)) {
          throw new DatabaseConnectionError(
            `Failed to create index on Memory(${prop}): ${err}`
          );
        }
      }
    }

    // UNIQUE constraint requires a supporting (exact-match) range index on
    // the `id` property; both must exist before the constraint is created.
    if (typeof this.graph.constraintCreate !== "function") {
      // Without the constraint helper the UNIQUE on Memory.id cannot be
      // guaranteed, so the schema must not be considered initialized.
      throw new DatabaseConnectionError(
        `${this._display_name} graph does not support UNIQUE constraint creation`
      );
    }

    // Create the supporting range index and the constraint in separate try
    // blocks. If the index already exists (e.g. a partial schema was built on
    // a prior run) the constraint must still be attempted; otherwise a
    // database that has the index but no constraint would silently accept
    // duplicate Memory ids. Non-duplicate failures propagate.
    try {
      await this.graph.createNodeRangeIndex("Memory", ["id"]);
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        throw new DatabaseConnectionError(
          `Failed to create range index on Memory(id): ${err}`
        );
      }
    }
    try {
      await this.graph.constraintCreate("UNIQUE", "NODE", "Memory", "id");
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        throw new DatabaseConnectionError(
          `Failed to create UNIQUE constraint on Memory.id (legacy data may contain duplicate ids): ${err}`
        );
      }
    }

    // Constraint creation may be asynchronous in some servers; poll until the
    // operational UNIQUE constraint and the required range indexes are
    // visible, bounded by a short number of attempts.
    await this.waitForSchema(indexProps);

    console.log("Schema initialization completed");
    this._schemaInitialized = true;
  }

/**
 * Whether the operational `Memory` schema (per-property range indexes plus
 * the UNIQUE constraint on `id`) already exists in the graph. Used to skip
 * DDL on startup when an existing, populated database is opened.
 *
 * Returns:
 *  - `true`  when the required schema is verified operational,
 *  - `false` when the schema is verifiable but not yet complete,
 *  - `null`  when introspection itself is not available (the driver or server
 *            does not implement `call db.indexes()` / `call db.constraints()`).
 *
 * Introspection is payload-tolerant: a driver may return one row with all
 * indexes/constraints aggregated, or one row apiece. Each row is checked for
 * the operational marker (`entitytype: NODE`, `status: OPERATIONAL`) and its
 * property metadata aggregated, so the exact operational schema is verified
 * rather than a loose substring of the property names.
 */
private async schemaExists(indexProps: string[]): Promise<boolean | null> {
  try {
    const [indexResult, constraintResult] = await Promise.all([
      this.executeQuery("call db.indexes()", {}, true),
      this.executeQuery("call db.constraints()", {}, true),
    ]);

    const indexedProps = new Set<string>();
    for (const row of indexResult ?? []) {
      if (!isOperationalNodeRow(row)) continue;
      for (const prop of collectIndexedRangeProps(row)) indexedProps.add(prop);
    }

    const hasConstraint = operationalMemoryConstraintPresent(
      constraintResult ?? []
    );

    const requiredIndexes = ["id", ...indexProps];
    return (
      hasConstraint &&
      requiredIndexes.every((prop) => indexedProps.has(prop))
    );
  } catch {
    // Introspection is not available (e.g. older client or a server without
    // these procedures); the caller cannot verify the schema.
    return null;
  }
}

  /**
   * Poll introspection until the operational `Memory` schema (required range
   * indexes plus the UNIQUE constraint on `id`) is visible. Constraint/index
   * creation can be asynchronous on some servers; this gives it a bounded time
   * to become OPERATIONAL rather than declaring success immediately.
   *
   * When introspection is unsupported the DDL has already succeeded, so the
   * wait is skipped rather than failing initialization on a healthy database.
   */
  private async waitForSchema(indexProps: string[]): Promise<void> {
    const attempts = 10;
    for (let i = 0; i < attempts; i++) {
      const state = await this.schemaExists(indexProps);
      // Introspection unsupported (null) or schema verified (true): accept it.
      if (state === null || state === true) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new DatabaseConnectionError(
      `Schema initialization did not become OPERATIONAL after ${attempts} attempts for ${this._display_name}`
    );
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  async storeMemory(memory: Memory): Promise<string> {
    try {
      if (!memory.id) {
        memory.id = randomUUID();
      }
      memory.updated_at = new Date().toISOString();

      const properties = memoryToNodeProperties(memory);

      const query = `
        MERGE (m:Memory {id: $id})
        SET m += $properties
        RETURN m.id as id
      `;

      const result = await this.executeQuery(
        query,
        { id: memory.id, properties },
        true
      );

      if (result.length > 0) {
        console.log(`Stored memory: ${memory.id} (${memory.type})`);
        return result[0]["id"] as string;
      }
      throw new DatabaseConnectionError(`Failed to store memory: ${memory.id}`);
    } catch (err) {
      if (err instanceof DatabaseConnectionError || err instanceof ValidationError) throw err;
      console.error(`Failed to store memory: ${err}`);
      throw new DatabaseConnectionError(`Failed to store memory: ${err}`);
    }
  }

  async getMemory(memoryId: string, _includeRelationships = true): Promise<Memory | null> {
    try {
      const query = `
        MATCH (m:Memory {id: $memory_id})
        RETURN m
      `;
      const result = await this.executeQuery(query, { memory_id: memoryId }, false);
      if (result.length === 0) return null;
      return parseMemoryFromProperties(result[0]["m"] as Record<string, unknown>, this._display_name);
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to get memory ${memoryId}: ${err}`);
      throw new DatabaseConnectionError(`Failed to get memory: ${err}`);
    }
  }

  async searchMemories(searchQuery: SearchQuery): Promise<Memory[]> {
    try {
      const conditions: string[] = [];
      const parameters: Record<string, unknown> = {};

      if (searchQuery.query) {
        conditions.push(
          "(m.title CONTAINS $query OR m.content CONTAINS $query OR m.summary CONTAINS $query)"
        );
        parameters["query"] = searchQuery.query;
      }

      if (searchQuery.memory_types.length > 0) {
        conditions.push("m.type IN $memory_types");
        parameters["memory_types"] = searchQuery.memory_types;
      }

      if (searchQuery.tags.length > 0) {
        conditions.push("ANY(tag IN $tags WHERE tag IN m.tags)");
        parameters["tags"] = searchQuery.tags;
      }

      if (searchQuery.project_path) {
        conditions.push("m.context_project_path = $project_path");
        parameters["project_path"] = searchQuery.project_path;
      }

      if (searchQuery.min_importance !== undefined && searchQuery.min_importance !== null) {
        conditions.push("m.importance >= $min_importance");
        parameters["min_importance"] = searchQuery.min_importance;
      }

      if (searchQuery.min_confidence !== undefined && searchQuery.min_confidence !== null) {
        conditions.push("m.confidence >= $min_confidence");
        parameters["min_confidence"] = searchQuery.min_confidence;
      }

      const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "true";

      const query = `
        MATCH (m:Memory)
        WHERE ${whereClause}
        RETURN m
        ORDER BY m.importance DESC, m.created_at DESC
        SKIP $offset
        LIMIT $limit
      `;
      parameters["limit"] = searchQuery.limit;
      parameters["offset"] = searchQuery.offset ?? 0;

      const result = await this.executeQuery(query, parameters, false);
      const memories: Memory[] = [];
      for (const record of result) {
        const mem = parseMemoryFromProperties(record["m"] as Record<string, unknown>, this._display_name);
        if (mem) memories.push(mem);
      }

      console.log(`Found ${memories.length} memories for search query`);
      return memories;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to search memories: ${err}`);
      throw new DatabaseConnectionError(`Failed to search memories: ${err}`);
    }
  }

  async updateMemory(memory: Memory): Promise<boolean> {
    try {
      if (!memory.id) throw new ValidationError("Memory must have an ID to update");
      memory.updated_at = new Date().toISOString();

      const properties = memoryToNodeProperties(memory);
      const cleared = clearedMemoryProperties(memory);

      // `SET m += $properties` only sets provided keys and leaves existing
      // ones untouched. Cleared optional fields (summary, effectiveness,
      // last_accessed, updated_by, context_summary, and null context
      // subfields) are omitted by memoryToNodeProperties, so `REMOVE` them
      // explicitly to avoid leaving stale values on the node.
      //
      // The cleared keys come from a schema whitelist, but filter them again
      // here to guarantee no non-identifier text is ever interpolated into the
      // Cypher string (defense in depth against crafted keys).
      const removable = cleared.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
      const removeClause =
        removable.length > 0
          ? `REMOVE ${removable.map((k) => `m.${k}`).join(", ")}`
          : "";

      const query = `
        MATCH (m:Memory {id: $id})
        SET m += $properties
        ${removeClause}
        RETURN m.id as id
      `;
      const result = await this.executeQuery(
        query,
        { id: memory.id, properties },
        true
      );

      const success = result.length > 0;
      if (success) console.log(`Updated memory: ${memory.id}`);
      return success;
    } catch (err) {
      if (err instanceof ValidationError || err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to update memory ${memory.id}: ${err}`);
      throw new DatabaseConnectionError(`Failed to update memory: ${err}`);
    }
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    try {
      const existsQuery = `
        MATCH (m:Memory {id: $memory_id})
        RETURN m.id as id
      `;
      const exists = await this.executeQuery(existsQuery, { memory_id: memoryId }, false);
      if (exists.length === 0) return false;

      const deleteQuery = `
        MATCH (m:Memory {id: $memory_id})
        DETACH DELETE m
      `;
      await this.executeQuery(deleteQuery, { memory_id: memoryId }, true);
      console.log(`Deleted memory: ${memoryId}`);
      return true;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to delete memory ${memoryId}: ${err}`);
      throw new DatabaseConnectionError(`Failed to delete memory: ${err}`);
    }
  }

  // -----------------------------------------------------------------------
  // Relationships
  // -----------------------------------------------------------------------

  async createRelationship(
    fromMemoryId: string,
    toMemoryId: string,
    relationshipType: string,
    properties?: RelationshipProperties
  ): Promise<string> {
    try {
      validateRelType(relationshipType);
      const relationshipId = randomUUID();
      const props = properties ?? createRelationshipProperties();

      const propsDict: Record<string, unknown> = { ...props, id: relationshipId };
      propsDict["created_at"] = toIso(props.created_at);
      propsDict["last_validated"] = toIso(props.last_validated);
      propsDict["valid_from"] = toIso(props.valid_from);
      propsDict["recorded_at"] = toIso(props.recorded_at);
      if (props.valid_until) propsDict["valid_until"] = toIso(props.valid_until);

      // FalkorDB (embedded lite) fails to inline map params used as
      // relationship properties ("Encountered unhandled type"). Inline a
      // safely-escaped literal map instead; only string/number/boolean are
      // emitted, so no values are lost.
      const propsLiteral = toCypherMapLiteral(propsDict);
      const query = `
        MATCH (from:Memory {id: $from_id})
        MATCH (to {id: $to_id})
        WHERE to:Memory OR to:Entity
        CREATE (from)-[r:${relationshipType} ${propsLiteral}]->(to)
        RETURN r.id as id
      `;

      const result = await this.executeQuery(
        query,
        { from_id: fromMemoryId, to_id: toMemoryId },
        true
      );

      if (result.length > 0) {
        console.log(
          `Created relationship: ${relationshipType} between ${fromMemoryId} and ${toMemoryId}`
        );
        return result[0]["id"] as string;
      }
      throw new RelationshipError(
        `Failed to create relationship between ${fromMemoryId} and ${toMemoryId}`,
        { from_id: fromMemoryId, to_id: toMemoryId, type: relationshipType }
      );
    } catch (err) {
      if (err instanceof RelationshipError || err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to create relationship: ${err}`);
      throw new RelationshipError(`Failed to create relationship: ${err}`);
    }
  }

  async getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[Memory, Relationship][]> {
    try {
      const relTypes = opts?.relationshipTypes;
      const maxDepth = Math.max(1, Math.min(Number(opts?.maxDepth ?? 2) || 2, MAX_TRAVERSAL_DEPTH));

      let relFilter = "";
      if (relTypes && relTypes.length > 0) {
        for (const rt of relTypes) validateRelType(rt);
        relFilter = `:${relTypes.join("|")}`;
      }

      const query = `
        MATCH (start:Memory {id: $memory_id})
        MATCH path=(start)-[r${relFilter}*1..${maxDepth}]-(related:Memory)
        WHERE related.id <> start.id
        // Aggregate to one row per related memory. relationships(path) (the
        // edge list) differs for every path, so a memory reachable by
        // multiple paths would otherwise produce a duplicate row and consume
        // the LIMIT. Order by smallest path (shortest edge list) then take the
        // first edge of that shortest path, so each related memory maps to a
        // single, shortest, truthful first hop from the start node.
        WITH related, relationships(path) as rels
        WITH related, rels ORDER BY size(rels) ASC, related.id
        WITH related, head(collect(rels)) as first_rels
        WITH DISTINCT related, head(first_rels) as first_rel
        RETURN related,
               type(first_rel) as rel_type,
               properties(first_rel) as rel_props,
               startNode(first_rel).id as rel_from_id,
               endNode(first_rel).id as rel_to_id
        ORDER BY rel_props.strength DESC, related.importance DESC
        LIMIT 20
      `;

      const result = await this.executeQuery(query, { memory_id: memoryId }, false);

      const relatedMemories: [Memory, Relationship][] = [];
      for (const record of result) {
        const mem = parseMemoryFromProperties(
          record["related"] as Record<string, unknown>,
          this._display_name
        );
        if (!mem) continue;

        const relTypeStr = (record["rel_type"] as string) ?? "RELATED_TO";
        const relProps = (record["rel_props"] as Record<string, unknown>) ?? {};
        // For a multi-hop path only the first edge (from memoryId) is
        // reported. The edge's real source/target ids (which may not be
        // `memoryId`/`mem.id` when the path spans intermediate memories) are
        // preserved so relationship data stays truthful for every hop.
        const relFrom = (record["rel_from_id"] as string | null | undefined) ?? memoryId;
        const relTo = (record["rel_to_id"] as string | null | undefined) ?? mem.id!;

        const relationship: Relationship = {
          id: (relProps["id"] as string) ?? null,
          from_memory_id: relFrom,
          to_memory_id: relTo,
          type: relTypeStr,
          properties: createRelationshipProperties({
            strength: (relProps["strength"] as number) ?? 0.5,
            confidence: (relProps["confidence"] as number) ?? 0.8,
            context: (relProps["context"] as string) ?? undefined,
            evidence_count: (relProps["evidence_count"] as number) ?? 1,
          }),
          description: null,
          bidirectional: false,
        };
        relatedMemories.push([mem, relationship]);
      }

      console.log(`Found ${relatedMemories.length} related memories for ${memoryId}`);
      return relatedMemories;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to get related memories for ${memoryId}: ${err}`);
      throw new DatabaseConnectionError(`Failed to get related memories: ${err}`);
    }
  }

  // -----------------------------------------------------------------------
  // Statistics
  // -----------------------------------------------------------------------

  async getMemoryStatistics(): Promise<Record<string, unknown>> {
    const queries: Record<string, string> = {
      total_memories: "MATCH (m:Memory) RETURN COUNT(m) as count",
      memories_by_type:
        "MATCH (m:Memory) RETURN m.type as type, COUNT(m) as count ORDER BY count DESC",
      total_relationships: "MATCH ()-[r]->() RETURN COUNT(r) as count",
      avg_importance: "MATCH (m:Memory) RETURN AVG(m.importance) as avg_importance",
      avg_confidence: "MATCH (m:Memory) RETURN AVG(m.confidence) as avg_confidence",
    };

    const stats: Record<string, unknown> = {};
    for (const [statName, query] of Object.entries(queries)) {
      try {
        const result = await this.executeQuery(query, {}, false);
        if (statName === "memories_by_type") {
          const byType: Record<string, number> = {};
          for (const record of result) {
            byType[record["type"] as string] = record["count"] as number;
          }
          stats[statName] = byType;
        } else {
          stats[statName] = result.length > 0 ? result[0] : null;
        }
      } catch (err) {
        console.error(`Failed to get statistic ${statName}: ${err}`);
        stats[statName] = null;
      }
    }
    return stats;
  }

  // -----------------------------------------------------------------------
  // Capability flags
  // -----------------------------------------------------------------------

  supportsFulltextSearch(): boolean {
    return true;
  }
  supportsTransactions(): boolean {
    return true;
  }
  isCypherCapable(): boolean {
    return true;
  }
}

/**
 * Whether a schema-init error means the index/constraint already exists
 * (expected on repeated runs) rather than a genuine failure.
 */
function isAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already (indexed|exists)/i.test(message);
}

/**
 * Whether a schema row from `call db.indexes()` / `call db.constraints()`
 * describes an operational node (Memory) index or constraint.
 */
function isOperationalNodeRow(row: Record<string, unknown>): boolean {
  const entityType = row["entitytype"] ?? row["entityType"];
  return (
    row["label"] === "Memory" &&
    String(entityType ?? "").toUpperCase() === "NODE" &&
    String(row["status"] ?? "").toUpperCase() === "OPERATIONAL"
  );
}

/**
 * Collect the RANGE-indexed property names from a schema index row.
 *
 * A FalkorDB index row carries the indexed properties in `properties` (a list)
 * and their index types in `types` (a map of property → list of index kinds).
 * Only properties that have a `RANGE` entry are treated as covered by a range
 * index, so a full-text or vector index cannot satisfy a required range-index
 * property. Drivers that omit `types` (older servers) fall back to the
 * `properties` list.
 */
function collectIndexedRangeProps(row: Record<string, unknown>): string[] {
  const rawProps = row["properties"];
  const rawTypes = row["types"];

  const props: string[] = [];

  if (rawTypes && typeof rawTypes === "object" && !Array.isArray(rawTypes)) {
    for (const [key, kinds] of Object.entries(rawTypes as Record<string, unknown>)) {
      const list = Array.isArray(kinds) ? kinds : [kinds];
      if (list.some((k) => String(k).toUpperCase() === "RANGE" || String(k).toUpperCase() === "RANGE_VALUE")) {
        props.push(key);
      }
    }
    return props;
  }

  // Fallback: no `types` metadata – assume the properties list is range-indexed.
  if (Array.isArray(rawProps)) {
    for (const p of rawProps) {
      if (typeof p === "string") props.push(p);
    }
  }

  return props;
}

/**
 * Whether any row in the `call db.constraints()` result is the operational
 * `UNIQUE` constraint on `Memory.id`.
 */
function operationalMemoryConstraintPresent(
  rows: Record<string, unknown>[]
): boolean {
  for (const row of rows ?? []) {
    if (!isOperationalNodeRow(row)) continue;
    if (String(row["type"] ?? "").toUpperCase() !== "UNIQUE") continue;
    const rawProps = row["properties"];
    if (Array.isArray(rawProps) && rawProps.includes("id")) return true;
    // Driver may expose the property positionally (e.g. integer-keyed rows).
    if (Object.values(row).some((v) => v === "id")) return true;
  }
  return false;
}

/**
 * Serialize a property record into a literal Cypher map, e.g.
 * `{strength:0.5, context:'text', id:'abc'}`. Keys and string values are
 * escaped; `null`/`undefined`/`Date`/booleans handled. Nested objects and
 * arrays are not emitted (relationship props are flat scalars), so those
 * (and non-identifier keys and non-finite numbers) are skipped. Every skipped
 * key is reported via `console.warn` so a caller can detect that a property
 * did not persist, rather than losing it silently.
 */
function toCypherMapLiteral(props: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(props)) {
    // Keys are emitted verbatim, so skip keys that are not valid Cypher
    // identifiers. Dropped keys are surfaced so a caller can detect that a
    // relationship property did not persist.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      console.warn(`toCypherMapLiteral: skipped non-identifier relationship property '${key}'`);
      continue;
    }
    const value = props[key];
    if (value === null || value === undefined) continue;
    let literal: string;
    if (typeof value === "string") {
      literal = `'${value
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")}'`;
    } else if (typeof value === "number") {
      // `NaN` / `Infinity` are not valid Cypher number literals; skip them
      // and report the drop so a caller can detect the property did not persist.
      if (!Number.isFinite(value)) {
        console.warn(`toCypherMapLiteral: skipped non-finite relationship property '${key}'`);
        continue;
      }
      literal = String(value);
    } else if (typeof value === "boolean") {
      literal = String(value);
    } else {
      // Nested objects/arrays are not supported as inline rel props; report
      // the drop so the caller knows the property was not persisted.
      console.warn(`toCypherMapLiteral: skipped unsupported relationship property '${key}' of type ${typeof value}`);
      continue;
    }
    parts.push(`${key}: ${literal}`);
  }
  return `{${parts.join(", ")}}`;
}

/**
 * Prepare query parameters for the FalkorDB JS client, which inlines them
 * into the CYPHER query string.
 *
 * - Top-level `null` params are preserved (Kordas `$name IS NULL`/`$name IN`
 *   patterns rely on them and the client serializes `null` as a scalar).
 * - Top-level `undefined` params are dropped (the inline serializer rejects
 *   `undefined`).
 * - Inside object (map) params, `null`/`undefined` keys are dropped because
 *   the client cannot serialize them ("Encountered unhandled type").
 * Arrays are preserved.
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => sanitizeValue(v));
    } else if (typeof value === "object" && !(value instanceof Date)) {
      out[key] = sanitizeNestedParams(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Sanitize a single value for the inline serializer, recursing into arrays and
 * nested objects so an object (or array) element can never smuggle a `null` /
 * `undefined` member that the inline serializer rejects.
 */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v));
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return sanitizeNestedParams(value as Record<string, unknown>);
  }
  return value;
}

/** Drop `null`/`undefined` from the leaves of a nested object (map) param. */
function sanitizeNestedParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}
