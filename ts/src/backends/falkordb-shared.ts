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
  TimeoutError,
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

      const query = `
        MATCH (from:Memory {id: $from_id})
        MATCH (to {id: $to_id})
        WHERE to:Memory OR to:Entity
        CREATE (from)-[r:${relationshipType} $properties]->(to)
        RETURN r.id as id
      `;

      const result = await this.executeQuery(
        query,
        { from_id: fromMemoryId, to_id: toMemoryId, properties: propsDict },
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
        MATCH (start)-[r${relFilter}*1..${maxDepth}]-(related:Memory)
        WHERE related.id <> start.id
        WITH DISTINCT related, r[0] as rel
        RETURN related,
               type(rel) as rel_type,
               properties(rel) as rel_props
        ORDER BY rel.strength DESC, related.importance DESC
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

        const relationship: Relationship = {
          id: (relProps["id"] as string) ?? null,
          from_memory_id: memoryId,
          to_memory_id: mem.id!,
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
