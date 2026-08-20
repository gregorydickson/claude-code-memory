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
    if (value && typeof value === "object") {
      // FalkorDB node: { id, labels, properties: { ... } } → flatten properties
      if ("properties" in value && typeof value.properties === "object") {
        return { ...value.properties };
      }
      // Recurse into plain objects / arrays to flatten nested node values.
      if (Array.isArray(value)) {
        return value.map((v) => this.convertFalkorDBValue(v));
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
    if (await this.schemaExists(indexProps)) {
      this._schemaInitialized = true;
      return;
    }

    console.log(`Initializing ${this._display_name} schema...`);

    // The FalkorDB server does not accept the legacy `CREATE CONSTRAINT ON…`
    // Cypher string and duplicate index creation is not idempotent, so use
    // the client's native index/constraint helpers and treat "already
    // exists" errors as success.
    if (this.graph && typeof this.graph.createNodeRangeIndex === "function") {
      for (const prop of indexProps) {
        try {
          await this.graph.createNodeRangeIndex("Memory", [prop]);
        } catch (err) {
          if (!isAlreadyExistsError(err)) {
            console.warn(`Failed to create index on Memory(${prop}): ${err}`);
          }
        }
      }
      // UNIQUE constraint requires a supporting (exact-match) range index on
      // the `id` property; both must exist before the constraint is created.
      if (typeof this.graph.constraintCreate === "function") {
        // Create the supporting range index and the constraint in separate
        // try blocks. If the index already exists (e.g. a partial schema was
        // built on a prior run) the constraint must still be attempted;
        // otherwise a database that has the index but no constraint would
        // silently accept duplicate Memory ids.
        try {
          await this.graph.createNodeRangeIndex("Memory", ["id"]);
        } catch (err) {
          if (!isAlreadyExistsError(err)) {
            console.warn(`Failed to create range index on Memory(id): ${err}`);
          }
        }
        try {
          await this.graph.constraintCreate("UNIQUE", "NODE", "Memory", "id");
        } catch (err) {
          if (!isAlreadyExistsError(err)) {
            console.warn(
              `Failed to create UNIQUE constraint on Memory.id (legacy data may contain duplicate ids): ${err}`
            );
          }
        }
      }
    } else {
      for (const constraint of [
        "CREATE CONSTRAINT ON (m:Memory) ASSERT m.id IS UNIQUE",
      ]) {
        try {
          await this.executeQuery(constraint, {}, true);
        } catch (err) {
          if (!isAlreadyExistsError(err)) {
            console.warn(`Failed to create Memory.id constraint: ${err}`);
          }
        }
      }
      for (const index of indexProps) {
        try {
          await this.executeQuery(
            `CREATE INDEX ON :Memory(${index})`,
            {},
            true
          );
        } catch (err) {
          if (!isAlreadyExistsError(err)) {
            console.warn(`Failed to create index on Memory(${index}): ${err}`);
          }
        }
      }
    }

    console.log("Schema initialization completed");
    this._schemaInitialized = true;
  }

  /**
   * Whether the Memory schema (per-property range indexes plus the UNIQUE
   * constraint on `id`) already exists in the graph. Used to skip DDL on
   * startup when an existing, populated database is opened.
   */
  private async schemaExists(indexProps: string[]): Promise<boolean> {
    try {
      const [indexResult, constraintResult] = await Promise.all([
        this.executeQuery("call db.indexes()", {}, true),
        this.executeQuery("call db.constraints()", {}, true),
      ]);

      const existingIndexes = new Set<string>();
      for (const row of indexResult ?? []) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") existingIndexes.add(value);
        }
      }
      const existingConstraints = new Set<string>();
      for (const row of constraintResult ?? []) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") existingConstraints.add(value);
        }
      }

      const requiredIndexes = ["id", ...indexProps];
      const hasAllIndexes = requiredIndexes.every((prop) =>
        existingIndexes.has(prop)
      );
      const hasConstraint = existingConstraints.has("id");

      return hasAllIndexes && hasConstraint;
    } catch {
      // Introspection is not available (e.g. older client or a server without
      // these procedures); fall back to attempting creation.
      return false;
    }
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

      const query = `
        MATCH (m:Memory {id: $id})
        SET m += $properties
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
        WITH DISTINCT related, relationships(path) as rels,
             head(relationships(path)) as first_rel
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

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
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
 * Serialize a property record into a literal Cypher map, e.g.
 * `{strength:0.5, context:'text', id:'abc'}`. Keys and string values are
 * escaped; `null`/`undefined`/`Date`/booleans handled; nested objects and
 * arrays are not emitted (relationship props are flat scalars).
 */
function toCypherMapLiteral(props: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === null || value === undefined) continue;
    let literal: string;
    if (typeof value === "string") {
      literal = `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    } else if (typeof value === "number" || typeof value === "boolean") {
      literal = String(value);
    } else {
      continue; // nested objects/arrays not supported as inline rel props
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
      out[key] = value;
    } else if (typeof value === "object" && !(value instanceof Date)) {
      out[key] = sanitizeNestedParams(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Drop `null`/`undefined` from the leaves of a nested object (map) param. */
function sanitizeNestedParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      out[key] = value;
    } else if (typeof value === "object" && !(value instanceof Date)) {
      out[key] = sanitizeNestedParams(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
