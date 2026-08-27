/**
 * Shared base class for FalkorDB and FalkorDBLite backends.
 *
 * Both backends use the same graph query engine and Cypher dialect.
 * The only differences are connection setup (client-server vs embedded)
 * and health-check metadata. This module extracts the shared logic.
 */

import { randomUUID } from "node:crypto";

import { Config } from "../config.ts";
import {
  type Memory,
  type Relationship,
  type RelationshipProperties,
  type SearchQuery,
  memoryToNodeProperties,
  createRelationshipProperties,
  ALL_RELATIONSHIP_TYPES,
} from "../models.ts";
import {
  type GraphBackend,
  type HealthCheckResult,
} from "./base.ts";
import {
  DatabaseConnectionError,
  RelationshipError,
  TimeoutError,
  ValidationError,
} from "../errors.ts";
import { parseMemoryFromProperties } from "../utils/memory-parser.ts";
import { runRecentActivity } from "./recent-activity.ts";

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

    const params = parameters ?? {};
    const timeoutMs = Config.QUERY_TIMEOUT;

    try {
      const result = await this._runWithQueryTimeout(
        () => this.graph.query(query, { params }),
        timeoutMs
      );
      return this.convertFalkorDBResult(result);
    } catch (err) {
      if (err instanceof TimeoutError) {
        // Bounded query timeout fired — degrade to typed error, no hang.
        console.error(
          `Query timed out after ${timeoutMs}ms on ${this._display_name}: ${query.substring(0, 120)}`
        );
        throw err;
      }
      console.error(`Query execution failed: ${err}`);
      throw new DatabaseConnectionError(`Query execution failed: ${err}`);
    }
  }

  /**
   * Run a backend driver call with a bounded query timeout. If the call
   * does not resolve within `timeoutMs`, reject with a typed TimeoutError.
   *
   * The underlying driver call is not cancellable, but the caller sees a
   * fast, typed degradation instead of an indefinite hang.
   */
  private async _runWithQueryTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    if (!(timeoutMs > 0)) return fn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`Query timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private convertFalkorDBResult(result: any): Record<string, unknown>[] {
    const resultList: Record<string, unknown>[] = [];
    if (!result) return resultList;

    // FalkorDB JS client returns { data: [...], header: [...] }
    const resultSet = result.data ?? result.result_set ?? result;
    if (!Array.isArray(resultSet)) return resultList;

    // Get column names from header (SDK uses both `headers` and `header`
    // spellings across versions; tolerate either).
    let columnNames: string[] = [];
    const headerSrc = result.headers ?? result.header;
    if (headerSrc) {
      columnNames = headerSrc.map((h: any) => {
        if (Array.isArray(h) && h.length >= 2) return h[1];
        return String(h);
      });
    }

    for (const row of resultSet) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        // Dict-like row keyed by column name (the falkordb-ts SDK returns
        // rows as objects like { m: <node> }). Convert EACH value so nodes
        // and relationships are flattened to their property dicts, which is
        // what parseMemoryFromProperties expects.
        const record: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          record[k] = this.convertFalkorDBValue(v);
        }
        resultList.push(record);
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
    if (value && typeof value === "object" && "properties" in value) {
      // FalkorDB node/relationship: flatten to its property dict.
      return { ...value.properties };
    }
    return value;
  }

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  async initializeSchema(): Promise<void> {
    console.log(`Initializing ${this._display_name} schema...`);

    // FalkorDB v4.16.3 requires the `GRAPH.CONSTRAINT` command form (not
    // legacy `CREATE CONSTRAINT ...`). The legacy form errors with
    // "Invalid constraint command use the GRAPH.CONSTRAINT command instead".
    //
    // FalkorDB also requires a supporting exact-match index to exist on the
    // property BEFORE a UNIQUE constraint is created (otherwise the
    // constraint call errors with "missing supporting exact-match index").
    // So we create the indexes first, then the constraint.
    //
    // We never swallow errors silently — a schema-init failure that isn't
    // the "already exists" case is logged and propagated.

    const indexes = [
      "CREATE INDEX ON :Memory(id)",
      "CREATE INDEX ON :Memory(type)",
      "CREATE INDEX ON :Memory(created_at)",
      "CREATE INDEX ON :Memory(importance)",
      "CREATE INDEX ON :Memory(confidence)",
    ];

    if (Config.isMultiTenantMode()) {
      indexes.push(
        "CREATE INDEX ON :Memory(context_tenant_id)",
        "CREATE INDEX ON :Memory(context_team_id)",
        "CREATE INDEX ON :Memory(context_visibility)",
        "CREATE INDEX ON :Memory(context_created_by)",
        "CREATE INDEX ON :Memory(version)"
      );
    }

    for (const index of indexes) {
      try {
        await this.executeQuery(index, {}, true);
      } catch (err) {
        const msg = String(err);
        if (/already exists|already indexed/i.test(msg)) {
          // Index already exists — benign, continue.
          continue;
        }
        // Surface (do not swallow) unexpected index failures.
        console.error(`Failed to create index (${index}): ${err}`);
        throw new DatabaseConnectionError(
          `Schema init failed creating index (${index}): ${err}`
        );
      }
    }

    // Now create the unique constraint on :Memory.id, using the v4.16.3
    // GRAPH.CONSTRAINT command form. Prefer the SDK helper when available.
    const constraintDesc = "unique constraint on :Memory.id";
    try {
      if (this.graph && typeof this.graph.constraintCreate === "function") {
        // constraintCreate(type, entityType, label, ...properties)
        await this.graph.constraintCreate("UNIQUE", "NODE", "Memory", "id");
      } else {
        await this.executeQuery(
          "GRAPH.CONSTRAINT CREATE memorygraph UNIQUE NODE Memory PROPERTIES 1 id",
          {},
          true
        );
      }
    } catch (err) {
      const msg = String(err);
      if (/already exists/i.test(msg)) {
        console.log(`Constraint already exists (${constraintDesc}); skipping.`);
      } else {
        console.error(`Failed to create constraint (${constraintDesc}): ${err}`);
        throw new DatabaseConnectionError(
          `Schema init failed creating constraint (${constraintDesc}): ${err}`
        );
      }
    }

    console.log("Schema initialization completed");
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

      // VAL-REVIEW-019: these SearchQuery fields were accepted by the schema
      // but silently ignored by every local backend — queries returned rows
      // outside the requested date/effectiveness bounds. created_at is an
      // ISO string, so lexicographic comparison is chronologically correct.
      if (searchQuery.min_effectiveness !== undefined && searchQuery.min_effectiveness !== null) {
        conditions.push("m.effectiveness >= $min_effectiveness");
        parameters["min_effectiveness"] = searchQuery.min_effectiveness;
      }

      if (searchQuery.created_after) {
        conditions.push("m.created_at >= $created_after");
        parameters["created_after"] = toIso(searchQuery.created_after);
      }

      if (searchQuery.created_before) {
        conditions.push("m.created_at <= $created_before");
        parameters["created_before"] = toIso(searchQuery.created_before);
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
      const now = new Date().toISOString();
      memory.updated_at = now;

      const properties = memoryToNodeProperties(memory);

      // H7 (VAL-LOCAL-017..019): minimal memory versioning. Before
      // overwriting the memory, snapshot the CURRENT (pre-update) state
      // into a `:MemoryVersion` node linked via `(:Memory)-[:HAS_VERSION]
      // ->(:MemoryVersion)`. The snapshot records `state_valid_from`
      // (= the prior `updated_at` or `created_at`) and `state_valid_until`
      // (= `now`, the update timestamp). `getMemoryStateAt(id, ts)` then
      // returns the snapshot whose `[state_valid_from, state_valid_until)`
      // contains `ts`, or the current memory if `ts >= current.updated_at`.
      //
      // The memory ID is stable (we SET in place), so `getMemory(id)` and
      // all existing tests continue to work; the version chain is purely
      // additive. `properties(m)` copies all current properties into the
      // snapshot; we then add the version-specific metadata. We use SET
      // (not inlined CREATE properties) to avoid FalkorDB's "unhandled
      // type null" error on inlined nulls.
      const query = `
        MATCH (m:Memory {id: $id})
        CREATE (v:MemoryVersion)
        SET v += properties(m),
            v.version_for = $id,
            v.state_valid_from = coalesce(m.updated_at, m.created_at),
            v.state_valid_until = $now,
            v.version_number = coalesce(m.version, 1)
        CREATE (m)-[:HAS_VERSION]->(v)
        SET m += $properties,
            m.updated_at = $now,
            m.version = coalesce(m.version, 1) + 1
        RETURN m.id as id
      `;
      const result = await this.executeQuery(
        query,
        { id: memory.id, properties, now },
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
      if (props.invalidated_by) propsDict["invalidated_by"] = props.invalidated_by;

      // FalkorDB's Cypher engine errors with "Encountered unhandled type in
      // inlined properties" when a CREATE property map contains `null` or
      // `undefined` values. Strip them before sending so optional fields
      // (context, success_rate, valid_until, invalidated_by) are simply
      // absent rather than null. This is required for the M6 relationship-
      // direction test (VAL-LOCAL-013) to exercise the falkordblite path.
      const cleanProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(propsDict)) {
        if (v !== null && v !== undefined) cleanProps[k] = v;
      }

      const query = `
        MATCH (from:Memory {id: $from_id})
        MATCH (to {id: $to_id})
        WHERE to:Memory OR to:Entity
        CREATE (from)-[r:${relationshipType}]->(to)
        SET r += $properties
        RETURN r.id as id
      `;

      const result = await this.executeQuery(
        query,
        { from_id: fromMemoryId, to_id: toMemoryId, properties: cleanProps },
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
    opts?: { relationshipTypes?: string[]; maxDepth?: number; limit?: number }
  ): Promise<[Memory, Relationship][]> {
    try {
      const relTypes = opts?.relationshipTypes;
      const maxDepth = Math.max(1, Math.min(Number(opts?.maxDepth ?? 2) || 2, MAX_TRAVERSAL_DEPTH));
      // VAL-REVIEW-018: the LIMIT 20 cap was invisible to callers (export,
      // as-of analysis). Callers may now lift it via opts.limit; the
      // interactive default stays 20.
      const rowLimit = Math.max(1, Math.min(Math.trunc(Number(opts?.limit ?? 20) || 20), 10000));

      let relFilter = "";
      if (relTypes && relTypes.length > 0) {
        for (const rt of relTypes) validateRelType(rt);
        relFilter = `:${relTypes.join("|")}`;
      }

      // M6 (VAL-LOCAL-013): use startNode(rel)/endNode(rel) so the
      // relationship direction is taken from the actual stored edge, NOT
      // always `from_memory_id: memoryId`. The previous code reversed
      // incoming edges (it set from_memory_id = memoryId for every row,
      // which made A→B appear as B→A when queried from B). We also return
      // the full rel properties (recorded_at, valid_from, valid_until, ...)
      // so the temporal handlers (history / as-of / what-changed) see the
      // real bi-temporal metadata.
      //
      // We extract the first relationship via `relationships(path)[0]`
      // because FalkorDB's `r[0]` indexing on a variable-length path
      // returns a value that startNode()/endNode() reject with
      // "Type mismatch: expected String but was Integer". `relationships()`
      // reliably returns a list of relationship objects.
      const query = `
        MATCH (start:Memory {id: $memory_id})
        MATCH path = (start)-[r${relFilter}*1..${maxDepth}]-(related:Memory)
        WHERE related.id <> start.id
        WITH DISTINCT related, relationships(path)[0] as rel
        RETURN related,
               type(rel) as rel_type,
               properties(rel) as rel_props,
               startNode(rel).id as from_id,
               endNode(rel).id as to_id
        ORDER BY rel.strength DESC, related.importance DESC
        LIMIT ${rowLimit}
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

        // Direction comes from the stored edge, not from which side we
        // queried from. Fall back to memoryId/mem.id only if the driver
        // returned neither endpoint (defensive — should never happen).
        const fromId = (record["from_id"] as string) ?? memoryId;
        const toId = (record["to_id"] as string) ?? mem.id!;

        const relationship: Relationship = {
          id: (relProps["id"] as string) ?? null,
          from_memory_id: fromId,
          to_memory_id: toId,
          type: relTypeStr,
          properties: createRelationshipProperties({
            strength: (relProps["strength"] as number) ?? 0.5,
            confidence: (relProps["confidence"] as number) ?? 0.8,
            context: (relProps["context"] as string) ?? undefined,
            evidence_count: (relProps["evidence_count"] as number) ?? 1,
            valid_from: relProps["valid_from"] as string | undefined,
            valid_until: relProps["valid_until"] as string | undefined,
            recorded_at: relProps["recorded_at"] as string | undefined,
            invalidated_by: relProps["invalidated_by"] as string | undefined,
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
  // Recent activity (VAL-REVIEW-017: shared Cypher port of the sqlite impl)
  // -----------------------------------------------------------------------

  async getRecentActivity(days = 7, project?: string | null): Promise<Record<string, unknown>> {
    return runRecentActivity(
      (query, parameters, write) => this.executeQuery(query, parameters, write),
      this._display_name,
      days,
      project
    );
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
  // Recall (M1 / VAL-LOCAL-031)
  // -----------------------------------------------------------------------

  /**
   * Recall memories with a recall-specific ranking that differs from
   * `searchMemories`. Search orders by `importance DESC, created_at DESC`;
   * recall orders by a composite `recall_score` that weighs `importance`,
   * `confidence`, `effectiveness`, `usage_count`, and `last_accessed`
   * recency. For memories with different `usage_count` / `effectiveness` /
   * `last_accessed`, the recall ordering differs from the search ordering —
   * this is the M1 fix that makes `recall != search` on falkordblite.
   *
   * The filter clause matches `searchMemories` (CONTAINS on
   * title/content/summary) so recall is a superset of search's match
   * candidates; only the ranking differs.
   */
  async recallMemories(
    query: string,
    opts?: { memoryTypes?: string[]; projectPath?: string; limit?: number }
  ): Promise<Memory[]> {
    try {
      const conditions: string[] = [];
      const parameters: Record<string, unknown> = {};

      if (query) {
        conditions.push(
          "(m.title CONTAINS $query OR m.content CONTAINS $query OR m.summary CONTAINS $query)"
        );
        parameters["query"] = query;
      }

      if (opts?.memoryTypes && opts.memoryTypes.length > 0) {
        conditions.push("m.type IN $memory_types");
        parameters["memory_types"] = opts.memoryTypes;
      }

      if (opts?.projectPath) {
        conditions.push("m.context_project_path = $project_path");
        parameters["project_path"] = opts.projectPath;
      }

      const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "true";
      const limit = opts?.limit ?? 20;

      // Recall score: importance 40%, confidence 20%, effectiveness 20%,
      // usage_count 10% (capped), last_accessed recency 10%. Memories with
      // no effectiveness / last_accessed fall back to neutral mid-scores
      // so they are not penalised to zero.
      const query_str = `
        MATCH (m:Memory)
        WHERE ${whereClause}
        WITH m,
             (coalesce(m.importance, 0.5) * 0.4 +
              coalesce(m.confidence, 0.8) * 0.2 +
              coalesce(m.effectiveness, 0.5) * 0.2 +
              coalesce(m.usage_count, 0) * 0.002 +
              CASE WHEN m.last_accessed IS NOT NULL THEN 0.1 ELSE 0.0 END) as recall_score
        RETURN m, recall_score
        ORDER BY recall_score DESC, m.importance DESC, m.created_at DESC
        LIMIT $limit
      `;
      parameters["limit"] = limit;

      const result = await this.executeQuery(query_str, parameters, false);
      const memories: Memory[] = [];
      for (const record of result) {
        const mem = parseMemoryFromProperties(record["m"] as Record<string, unknown>, this._display_name);
        if (mem) {
          // Attach a recall-specific match_info so consumers can tell
          // recall results apart from search results.
          mem.match_info = {
            match_quality: "recall",
            recall_score: record["recall_score"],
            matched_fields: ["title", "content", "summary"],
          };
          memories.push(mem);
        }
      }

      console.log(`Recalled ${memories.length} memories for query`);
      return memories;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to recall memories: ${err}`);
      throw new DatabaseConnectionError(`Failed to recall memories: ${err}`);
    }
  }

  // -----------------------------------------------------------------------
  // H7 temporal — minimal memory versioning (VAL-LOCAL-017..019)
  // -----------------------------------------------------------------------

  /**
   * Return the memory's state at `timestamp`. Uses the `:MemoryVersion`
   * snapshots created by `updateMemory`. If `timestamp >= current.updated_at`
   * (no update has happened since), returns the current memory. If a version
   * snapshot covers `timestamp` (`state_valid_from <= ts < state_valid_until`),
   * returns that snapshot. If `timestamp < memory.created_at` (the memory
   * did not exist yet), returns null.
   */
  async getMemoryStateAt(memoryId: string, timestamp: Date): Promise<Memory | null> {
    try {
      const tsIso = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);
      const query = `
        MATCH (m:Memory {id: $memory_id})
        OPTIONAL MATCH (m)-[:HAS_VERSION]->(v:MemoryVersion)
        WHERE v.state_valid_from <= $ts AND v.state_valid_until > $ts
        WITH m, v
        ORDER BY v.state_valid_until ASC
        LIMIT 1
        RETURN m as current_node, v as version_node
      `;
      const result = await this.executeQuery(query, { memory_id: memoryId, ts: tsIso }, false);
      if (result.length === 0) return null;

      const record = result[0];
      const versionNode = record["version_node"] as Record<string, unknown> | null | undefined;
      const currentNode = record["current_node"] as Record<string, unknown> | null | undefined;

      if (versionNode && Object.keys(versionNode).length > 0) {
        // A historical version covers the timestamp.
        return parseMemoryFromProperties(versionNode, this._display_name);
      }

      if (!currentNode) return null;

      // No historical version covers the timestamp. If the memory existed
      // at the timestamp (created_at <= ts), return the current state —
      // either no update has happened since the timestamp, or the timestamp
      // is after the last update. If the memory did not exist yet, return null.
      const current = parseMemoryFromProperties(currentNode, this._display_name);
      if (!current) return null;
      const created = current.created_at instanceof Date
        ? current.created_at.toISOString()
        : String(current.created_at);
      if (tsIso < created) return null;
      return current;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to get memory state at ${timestamp} for ${memoryId}: ${err}`);
      throw new DatabaseConnectionError(`Failed to get memory state: ${err}`);
    }
  }

  /**
   * Return the memory's version history (newest-first), including the
   * current state and all `:MemoryVersion` snapshots. Each entry is a
   * parsed Memory; the current state is the first entry (highest
   * `state_valid_until` / no `state_valid_until`).
   */
  async getMemoryVersions(memoryId: string): Promise<Memory[]> {
    try {
      // Use `properties(m)` / `collect(properties(v))` so the SDK returns
      // flat property dicts (the convertFalkorDBValue flattener only
      // processes top-level row values, not nested elements inside a
      // `collect()` list). Without this, `collect(v)` returns wrapped
      // node objects ({ id, labels, properties }) that
      // parseMemoryFromProperties cannot parse.
      const query = `
        MATCH (m:Memory {id: $memory_id})
        OPTIONAL MATCH (m)-[:HAS_VERSION]->(v:MemoryVersion)
        RETURN properties(m) as current_node,
               [x IN collect(v) WHERE x IS NOT NULL | properties(x)] as version_nodes
      `;
      const result = await this.executeQuery(query, { memory_id: memoryId }, false);
      if (result.length === 0) return [];

      const record = result[0];
      const currentNode = record["current_node"] as Record<string, unknown> | null | undefined;
      const versionNodes = (record["version_nodes"] as Record<string, unknown>[] | null | undefined) ?? [];

      const versions: Memory[] = [];

      // Current state first (newest).
      if (currentNode && Object.keys(currentNode).length > 0) {
        const current = parseMemoryFromProperties(currentNode, this._display_name);
        if (current) versions.push(current);
      }

      // Historical versions, newest-first by state_valid_until descending.
      const historical: Memory[] = [];
      for (const vnode of versionNodes) {
        if (!vnode || Object.keys(vnode).length === 0) continue;
        const mem = parseMemoryFromProperties(vnode, this._display_name);
        if (mem) historical.push(mem);
      }
      historical.sort((a, b) => {
        const aTs = (a.updated_at instanceof Date ? a.updated_at.toISOString() : String(a.updated_at ?? ""));
        const bTs = (b.updated_at instanceof Date ? b.updated_at.toISOString() : String(b.updated_at ?? ""));
        return bTs.localeCompare(aTs);
      });
      versions.push(...historical);

      return versions;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to get memory versions for ${memoryId}: ${err}`);
      throw new DatabaseConnectionError(`Failed to get memory versions: ${err}`);
    }
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

  // -----------------------------------------------------------------------
  // Bi-temporal change feed (M12 / VAL-LOCAL-014)
  // -----------------------------------------------------------------------

  /**
   * Single Cypher query filtering relationships by `recorded_at >= $since`.
   * Replaces the N+1 per-memory loop in `handleWhatChanged` (which also
   * implicitly capped at 1000 memories via `searchMemories({limit: 1000})`).
   * Returns the full matching set with no truncation.
   */
  async getRelationshipsSince(since: Date): Promise<Relationship[]> {
    try {
      const sinceIso = since instanceof Date ? since.toISOString() : String(since);
      const query = `
        MATCH (from:Memory)-[r]->(to:Memory)
        WHERE r.recorded_at >= $since
           OR (r.valid_until IS NOT NULL AND r.valid_until >= $since)
        RETURN r.id as id, type(r) as rel_type, properties(r) as rel_props,
               from.id as from_id, to.id as to_id
        ORDER BY r.recorded_at ASC
      `;
      const result = await this.executeQuery(query, { since: sinceIso }, false);

      const relationships: Relationship[] = [];
      for (const record of result) {
        const relProps = (record["rel_props"] as Record<string, unknown>) ?? {};
        const relTypeStr = (record["rel_type"] as string) ?? "RELATED_TO";
        relationships.push({
          id: (relProps["id"] as string) ?? null,
          from_memory_id: (record["from_id"] as string) ?? "",
          to_memory_id: (record["to_id"] as string) ?? "",
          type: relTypeStr,
          properties: createRelationshipProperties({
            strength: (relProps["strength"] as number) ?? 0.5,
            confidence: (relProps["confidence"] as number) ?? 0.8,
            context: (relProps["context"] as string) ?? undefined,
            evidence_count: (relProps["evidence_count"] as number) ?? 1,
            valid_from: relProps["valid_from"] as string | undefined,
            valid_until: relProps["valid_until"] as string | undefined,
            recorded_at: relProps["recorded_at"] as string | undefined,
            invalidated_by: relProps["invalidated_by"] as string | undefined,
          }),
          description: null,
          bidirectional: false,
        });
      }
      return relationships;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to get relationships since ${since}: ${err}`);
      throw new DatabaseConnectionError(`Failed to get relationships since: ${err}`);
    }
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
