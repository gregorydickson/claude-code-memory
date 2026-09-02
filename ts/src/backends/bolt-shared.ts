/**
 * Shared base class for Bolt-protocol graph database backends.
 *
 * Works with any Bolt-compatible database (Memgraph, Neo4j) via the
 * `neo4j-driver` npm package. Provides the same Cypher-based CRUD
 * operations as BaseFalkorDBBackend, but uses Bolt protocol sessions
 * for query execution and handles neo4j-driver's Node/Relationship
 * result types.
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

const MAX_TRAVERSAL_DEPTH = 10;

function validateRelType(relType: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(relType)) {
    throw new ValidationError(
      `Invalid relationship type: '${relType}'. Only alphanumeric and underscore allowed.`
    );
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Convert neo4j-driver Integer objects to plain JS numbers. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (value && typeof value === "object" && "low" in value && "high" in value) {
    return (value as { low: number }).low;
  }
  return Number(value);
}

/** Convert a neo4j-driver Node/Relationship/Array to a plain object. */
function convertValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  // neo4j Node: has .properties, .labels, .elementId
  if ("properties" in value && ("labels" in value || "elementId" in value)) {
    const props = (value as { properties: Record<string, unknown> }).properties;
    return convertProperties(props);
  }

  // neo4j Relationship: has .properties, .type, .elementId
  if ("properties" in value && "type" in value) {
    return convertProperties((value as { properties: Record<string, unknown> }).properties);
  }

  // neo4j Integer
  if ("toNumber" in value) {
    return toNumber(value);
  }

  // Array
  if (Array.isArray(value)) {
    return value.map(convertValue);
  }

  // Plain object
  return convertProperties(value as Record<string, unknown>);
}

function convertProperties(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    if (val && typeof val === "object" && "toNumber" in val) {
      result[key] = toNumber(val);
    } else if (Array.isArray(val)) {
      result[key] = val.map((v) =>
        v && typeof v === "object" && "toNumber" in v ? toNumber(v) : v
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

export abstract class BaseBoltBackend implements GraphBackend {
  abstract _display_name: string;

  uri: string;
  username?: string;
  password?: string;
  driver: any = null;
  _connected = false;
  /** Whether the schema is known to be present for this connection. */
  private _schemaInitialized = false;
  /**
   * In-flight schema initialization promise for this connection. Stored
   * BEFORE the first awaited database operation so concurrent same-instance
   * callers share a single DDL run instead of both passing the completed
   * boolean guard and issuing DDL concurrently. Cleared after the promise
   * settles and on disconnect.
   */
  private _schemaInitPromise: Promise<void> | null = null;

  constructor(uri: string, username?: string, password?: string) {
    this.uri = uri;
    this.username = username;
    this.password = password;
  }

  // -----------------------------------------------------------------------
  // Abstract methods
  // -----------------------------------------------------------------------

  abstract connect(): Promise<boolean>;
  abstract healthCheck(): Promise<HealthCheckResult>;
  abstract backendName(): string;

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  protected async createDriver(): Promise<any> {
    let neo4j: any;
    try {
      neo4j = await import("neo4j-driver");
    } catch {
      throw new DatabaseConnectionError(
        `neo4j-driver package is required for ${this._display_name}. ` +
          "Install with: bun add neo4j-driver"
      );
    }

    const authToken = this.password
      ? neo4j.auth.basic(this.username ?? "", this.password)
      : undefined;

    try {
      const driver = neo4j.driver(this.uri, authToken);
      // Verify connectivity
      await driver.verifyConnectivity();
      return driver;
    } catch (err) {
      throw new DatabaseConnectionError(
        `Failed to connect to ${this._display_name} at ${this.uri}: ${err}`
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      try {
        await this.driver.close();
      } catch {
        // best-effort close
      }
    }
    this.driver = null;
    this._connected = false;
    // A later connect() may target a recreated graph, so schema state must
    // not be carried across connections.
    this._schemaInitialized = false;
    this._schemaInitPromise = null;
    console.log(`${this._display_name} connection closed`);
  }

  // -----------------------------------------------------------------------
  // Query execution
  // -----------------------------------------------------------------------

  async executeQuery(
    query: string,
    parameters?: Record<string, unknown>,
    write = false
  ): Promise<Record<string, unknown>[]> {
    if (!this._connected || !this.driver) {
      throw new DatabaseConnectionError(
        `Connection failed: not connected to ${this._display_name} (call connect() first)`
      );
    }

    const params = parameters ?? {};
    const timeoutMs = Config.QUERY_TIMEOUT;
    const session = this.driver.session({
      defaultAccessMode: write ? "WRITE" : "READ",
    });

    try {
      const result: any = await this._runWithQueryTimeout(
        () => session.run(query, params),
        timeoutMs
      );
      const records: Record<string, unknown>[] = [];

      for (const record of result.records) {
        const obj: Record<string, unknown> = {};
        for (const key of record.keys) {
          obj[key] = convertValue(record.get(key));
        }
        records.push(obj);
      }
      return records;
    } catch (err) {
      if (err instanceof TimeoutError) {
        console.error(
          `Query timed out after ${timeoutMs}ms on ${this._display_name}: ${query.substring(0, 120)}`
        );
        throw err;
      }
      // Schema DDL duplicate errors are benign and handled by the caller.
      if (!isBenignSchemaError(err)) {
        console.error(`Query execution failed: ${err}`);
      }
      throw new DatabaseConnectionError(`Query execution failed: ${err}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Run a backend driver call with a bounded query timeout. If the call
   * does not resolve within `timeoutMs`, reject with a typed TimeoutError.
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

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  async initializeSchema(): Promise<void> {
    // Prevent the double-init seen when createDb() and the factory both call
    // initializeSchema() on the same backend instance within one process.
    if (this._schemaInitialized) {
      return;
    }
    // Single-flight: if another same-instance caller is already initializing
    // the schema, join that run instead of both passing the completed-guard
    // above and issuing DDL concurrently.
    if (this._schemaInitPromise) {
      return this._schemaInitPromise;
    }

    const init = (async () => {
      console.log(`Initializing ${this._display_name} schema...`);

      const indexes = [
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
          if (/already exists|already indexed|EquivalentIndex/i.test(msg)) {
            continue;
          }
          // VAL-REVIEW-020: surface unexpected index failures instead of
          // swallowing every error (matches the falkordb-shared behavior).
          console.error(`Failed to create index (${index}): ${err}`);
          throw new DatabaseConnectionError(
            `Schema init failed creating index (${index}): ${err}`
          );
        }
      }

      console.log("Schema initialization completed");
      this._schemaInitialized = true;
    })();

    // Store the in-flight promise before yielding so concurrent callers share
    // it; clear on settle (both success and failure) so a failure can retry.
    this._schemaInitPromise = init;
    try {
      return await init;
    } finally {
      this._schemaInitPromise = null;
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

      // VAL-REVIEW-019: honor the date/effectiveness filters the schema
      // promises (previously silently ignored on Bolt backends too).
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
    opts?: { relationshipTypes?: string[]; maxDepth?: number; limit?: number }
  ): Promise<[Memory, Relationship][]> {
    try {
      const relTypes = opts?.relationshipTypes;
      const maxDepth = Math.max(1, Math.min(Number(opts?.maxDepth ?? 2) || 2, MAX_TRAVERSAL_DEPTH));
      // VAL-REVIEW-018: allow callers (export, as-of) to lift the LIMIT 20.
      const rowLimit = Math.max(1, Math.min(Math.trunc(Number(opts?.limit ?? 20) || 20), 10000));

      let relFilter = "";
      if (relTypes && relTypes.length > 0) {
        for (const rt of relTypes) validateRelType(rt);
        relFilter = `:${relTypes.join("|")}`;
      }

      // M6 (VAL-LOCAL-013): use startNode(rel)/endNode(rel) so the
      // relationship direction is taken from the actual stored edge, NOT
      // always `from_memory_id: memoryId`. (Mirrors the falkordb-shared fix.)
      // Extract the first rel via `relationships(path)[0]` for driver
      // compatibility (varpath `r[0]` indexing is unreliable across
      // Cypher engines).
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

        const fromId = (record["from_id"] as string) ?? memoryId;
        const toId = (record["to_id"] as string) ?? mem.id!;

        const relationship: Relationship = {
          id: (relProps["id"] as string) ?? null,
          from_memory_id: fromId,
          to_memory_id: toId,
          type: relTypeStr,
          properties: createRelationshipProperties({
            strength: toNumber(relProps["strength"] ?? 0.5),
            confidence: toNumber(relProps["confidence"] ?? 0.8),
            context: (relProps["context"] as string) ?? undefined,
            evidence_count: toNumber(relProps["evidence_count"] ?? 1),
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
            byType[record["type"] as string] = toNumber(record["count"]);
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

  // -----------------------------------------------------------------------
  // Bi-temporal change feed (M12 / VAL-LOCAL-014)
  // -----------------------------------------------------------------------

  /**
   * Single Cypher query filtering relationships by `recorded_at >= $since`.
   * Mirrors the falkordb-shared implementation.
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
            strength: toNumber(relProps["strength"] ?? 0.5),
            confidence: toNumber(relProps["confidence"] ?? 0.8),
            context: (relProps["context"] as string) ?? undefined,
            evidence_count: toNumber(relProps["evidence_count"] ?? 1),
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

/**
 * Whether a query error is the benign "already indexed" / "already exists"
 * / "Equivalent index" DDL duplicate seen during schema init on repeated
 * runs. `executeQuery()` uses this to decide whether to log the failure at
 * its own level; the caller handles it.
 */
export function isBenignSchemaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already (indexed|exists)|Equivalent index/i.test(message);
}
