/**
 * SQLite fallback backend for MemoryGraph.
 *
 * Uses Node's built-in `node:sqlite` for persistence and in-memory graph
 * simulation for relationship traversal. This enables zero-server, zero-config
 * local storage without requiring FalkorDB or any external database server.
 *
 * `node:sqlite` is imported lazily inside `connect()` so that merely loading
 * this module (e.g. when bundled into the Bun-compiled binary that runs the
 * default falkordblite backend) does not require `node:sqlite` to be present
 * in the host runtime. The import is only attempted when the sqlite backend is
 * actually selected, which is also the only time it is needed (Node >= 20).
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { Config } from "../config.ts";
import {
  type Memory,
  type Relationship,
  type RelationshipProperties,
  type SearchQuery,
  createMemory,
  createRelationshipProperties,
  isRelationshipType,
  ALL_RELATIONSHIP_TYPES,
} from "../models.ts";
import {
  type GraphBackend,
  type HealthCheckResult,
} from "./base.ts";
import {
  DatabaseConnectionError,
  MemoryNotFoundError,
  RelationshipError,
  ValidationError,
} from "../errors.ts";

interface RelRow {
  id: string;
  from_id: string;
  to_id: string;
  rel_type: string;
  strength: number;
  confidence: number;
  context: string | null;
  evidence_count: number;
  valid_from: string;
  valid_until: string | null;
  recorded_at: string;
  invalidated_by: string | null;
  properties: string;
}

/**
 * Open a SQLite database for the current runtime.
 *
 * D1 Option C chose `node:sqlite` (built-in on Node >= 22) as the portability
 * target. Node provides `DatabaseSync`; Bun's runtime does not implement
 * `node:sqlite`, so under `bun test` and inside the Bun-compiled binary we
 * fall back to Bun's `Database` from `bun:sqlite`. Both expose the same
 * `exec` / `prepare` / `run` / `get` / `all` surface used below.
 *
 * Both imports are dynamic so that (a) merely loading this module never
 * requires either built-in to be present (important for the compiled binary's
 * default falkordblite path) and (b) no static Bun-module import specifier is
 * introduced (keeping ts/src/ free of Bun-specific import specifiers per
 * VAL-PORT-001). The create-on-open option is bun:sqlite-specific (node:sqlite's
 * DatabaseSync ctor has no such option — it creates the file by default); it is
 * required so bun:sqlite reopens a path that has stale -wal/-shm sidecar files
 * left by a prior close.
 */
type SqliteDatabase = DatabaseSync;

async function openSqliteDatabase(dbPath: string): Promise<SqliteDatabase> {
  try {
    const mod = await import("node:sqlite");
    return new mod.DatabaseSync(dbPath) as SqliteDatabase;
  } catch {
    // Bun runtime: node:sqlite is unavailable; fall back to bun:sqlite.
    const mod = await import("bun:sqlite") as unknown as {
      Database: new (path: string, options?: { create?: boolean }) => SqliteDatabase;
    };
    return new mod.Database(dbPath, { create: true });
  }
}

export class SQLiteBackend implements GraphBackend {
  dbPath: string;
  db: SqliteDatabase | null = null;
  _connected = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? Config.SQLITE_PATH;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch {
      // dir may exist
    }
  }

  async connect(): Promise<boolean> {
    try {
      this.db = await openSqliteDatabase(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA foreign_keys=ON;");
      this._connected = true;
      console.log(`Successfully connected to SQLite database at ${this.dbPath}`);
      return true;
    } catch (err) {
      console.error(`Failed to connect to SQLite: ${err}`);
      throw new DatabaseConnectionError(`Failed to connect to SQLite: ${err}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      // Checkpoint and truncate the WAL before closing so all written data is
      // flushed into the main database file and the -wal sidecar is emptied.
      // This makes the main .db file self-contained after close, which matters
      // for tests / callers that delete only the main file (leaving a stale
      // non-empty -wal would corrupt the next open).
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // ignore checkpoint errors (e.g. db already closing) — close anyway
      }
      this.db.close();
      this.db = null;
    }
    this._connected = false;
    console.log("SQLite connection closed");
  }

  async initializeSchema(): Promise<void> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.8,
        effectiveness REAL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        context TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        rel_type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.8,
        context TEXT,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        success_rate REAL,
        created_at TEXT NOT NULL,
        last_validated TEXT NOT NULL,
        validation_count INTEGER NOT NULL DEFAULT 0,
        counter_evidence_count INTEGER NOT NULL DEFAULT 0,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        recorded_at TEXT NOT NULL,
        invalidated_by TEXT,
        FOREIGN KEY (from_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (to_id) REFERENCES memories(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(rel_type);
    `);

    console.log("SQLite schema initialization completed");
  }

  async executeQuery(
    _query: string,
    _parameters?: Record<string, unknown>,
    _write?: boolean
  ): Promise<Record<string, unknown>[]> {
    throw new Error(
      "SQLite backend does not support Cypher queries. Use storeMemory(), searchMemories(), etc."
    );
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const info: HealthCheckResult = {
      connected: this._connected,
      backend_type: "sqlite",
      db_path: this.dbPath,
    };
    if (this._connected && this.db) {
      try {
        const row = this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as Record<string, unknown>;
        info["statistics"] = { memory_count: row["count"] };
      } catch (err) {
        info["warning"] = String(err);
      }
    }
    return info;
  }

  backendName(): string {
    return "sqlite";
  }
  supportsFulltextSearch(): boolean {
    return false;
  }
  supportsTransactions(): boolean {
    return true;
  }
  isCypherCapable(): boolean {
    return false;
  }

  // -- Memory CRUD --

  async storeMemory(memory: Memory): Promise<string> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");
    if (!memory.id) memory.id = randomUUID();
    memory.updated_at = new Date().toISOString();

    const contextJson = memory.context ? JSON.stringify(memory.context) : null;

    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO memories
           (id, type, title, content, summary, tags, importance, confidence, effectiveness,
            usage_count, created_at, updated_at, last_accessed, version, updated_by, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          memory.id,
          memory.type,
          memory.title,
          memory.content,
          memory.summary ?? null,
          JSON.stringify(memory.tags),
          memory.importance,
          memory.confidence,
          memory.effectiveness ?? null,
          memory.usage_count,
          toIso(memory.created_at),
          toIso(memory.updated_at),
          memory.last_accessed ? toIso(memory.last_accessed) : null,
          memory.version,
          memory.updated_by ?? null,
          contextJson
        );

      console.log(`Stored memory: ${memory.id} (${memory.type})`);
      return memory.id;
    } catch (err) {
      console.error(`Failed to store memory: ${err}`);
      throw new DatabaseConnectionError(`Failed to store memory: ${err}`);
    }
  }

  async getMemory(memoryId: string, _includeRelationships = true): Promise<Memory | null> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(memoryId) as Record<string, unknown> | null;
    if (!row) return null;
    return rowToMemory(row);
  }

  async searchMemories(searchQuery: SearchQuery): Promise<Memory[]> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (searchQuery.query) {
      conditions.push("(title LIKE ? OR content LIKE ? OR summary LIKE ?)");
      const pattern = `%${searchQuery.query}%`;
      params.push(pattern, pattern, pattern);
    }

    if (searchQuery.memory_types.length > 0) {
      const placeholders = searchQuery.memory_types.map(() => "?").join(",");
      conditions.push(`type IN (${placeholders})`);
      params.push(...searchQuery.memory_types);
    }

    if (searchQuery.tags.length > 0) {
      const tagConditions = searchQuery.tags.map(() => "tags LIKE ?").join(" OR ");
      conditions.push(`(${tagConditions})`);
      for (const tag of searchQuery.tags) {
        params.push(`%"${tag}"%`);
      }
    }

    if (searchQuery.project_path) {
      conditions.push("context LIKE ?");
      params.push(`%"project_path":"${searchQuery.project_path}"%`);
    }

    if (searchQuery.min_importance !== undefined && searchQuery.min_importance !== null) {
      conditions.push("importance >= ?");
      params.push(searchQuery.min_importance);
    }

    if (searchQuery.min_confidence !== undefined && searchQuery.min_confidence !== null) {
      conditions.push("confidence >= ?");
      params.push(searchQuery.min_confidence);
    }

    const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
    params.push(searchQuery.limit);
    params.push(searchQuery.offset ?? 0);

    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${whereClause} ORDER BY importance DESC, created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...(params as any[])) as Record<string, unknown>[];

    return rows.map(rowToMemory).filter((m): m is Memory => m !== null);
  }

  async updateMemory(memory: Memory): Promise<boolean> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");
    if (!memory.id) throw new ValidationError("Memory must have an ID to update");
    memory.updated_at = new Date().toISOString();

    const contextJson = memory.context ? JSON.stringify(memory.context) : null;

    const result = this.db
      .prepare(
        `UPDATE memories SET
         type = ?, title = ?, content = ?, summary = ?, tags = ?,
         importance = ?, confidence = ?, effectiveness = ?,
         usage_count = ?, updated_at = ?, last_accessed = ?,
         version = ?, updated_by = ?, context = ?
         WHERE id = ?`
      )
      .run(
        memory.type,
        memory.title,
        memory.content,
        memory.summary ?? null,
        JSON.stringify(memory.tags),
        memory.importance,
        memory.confidence,
        memory.effectiveness ?? null,
        memory.usage_count,
        toIso(memory.updated_at),
        memory.last_accessed ? toIso(memory.last_accessed) : null,
        memory.version,
        memory.updated_by ?? null,
        contextJson,
        memory.id
      );

    return result.changes > 0;
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");
    // Wrap the two-statement delete (rels + memory) in a SINGLE transaction
    // so a failure between the two statements cannot leave a memory deleted
    // but its relationships orphaned (or vice versa). See VAL-LOCAL-011.
    this.db.exec("BEGIN");
    try {
      // Delete relationships first.
      this.db
        .prepare("DELETE FROM relationships WHERE from_id = ? OR to_id = ?")
        .run(memoryId, memoryId);
      const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (err) {
      // Roll back any partial work so neither statement persists alone.
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors (e.g. txn already ended)
      }
      throw err;
    }
  }

  // -- Relationships --

  async createRelationship(
    fromMemoryId: string,
    toMemoryId: string,
    relationshipType: string,
    properties?: RelationshipProperties
  ): Promise<string> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");

    // SEC-11: validate the relationship type against the RelationshipType enum
    // before writing. Without this, sqlite would happily store any arbitrary
    // string in `relationships.rel_type`, which corrupts the graph (other
    // backends reject invalid types via Zod / Cypher schema) and breaks
    // export→import round-trips into a Cypher backend.
    if (!isRelationshipType(relationshipType)) {
      throw new RelationshipError(
        `Invalid relationship type: '${relationshipType}'. ` +
          `Valid types are: ${ALL_RELATIONSHIP_TYPES.join(", ")}`
      );
    }

    const relationshipId = randomUUID();
    const props = properties ?? createRelationshipProperties();

    // Check both memories exist
    const fromExists = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(fromMemoryId);
    const toExists = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(toMemoryId);
    if (!fromExists || !toExists) {
      throw new RelationshipError("One or both memories not found", {
        from_id: fromMemoryId,
        to_id: toMemoryId,
      });
    }

    this.db
      .prepare(
        `INSERT INTO relationships
         (id, from_id, to_id, rel_type, strength, confidence, context, evidence_count,
          success_rate, created_at, last_validated, validation_count, counter_evidence_count,
          valid_from, valid_until, recorded_at, invalidated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        relationshipId,
        fromMemoryId,
        toMemoryId,
        relationshipType,
        props.strength,
        props.confidence,
        props.context ?? null,
        props.evidence_count,
        props.success_rate ?? null,
        toIso(props.created_at),
        toIso(props.last_validated),
        props.validation_count,
        props.counter_evidence_count,
        toIso(props.valid_from),
        props.valid_until ? toIso(props.valid_until) : null,
        toIso(props.recorded_at),
        props.invalidated_by ?? null
      );

    console.log(`Created relationship: ${relationshipType} between ${fromMemoryId} and ${toMemoryId}`);
    return relationshipId;
  }

  async getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[Memory, Relationship][]> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");
    const maxDepth = Math.max(1, Math.min(Number(opts?.maxDepth ?? 2) || 2, 10));
    const relTypes = opts?.relationshipTypes;

    // For simplicity, do BFS up to maxDepth
    const visited = new Set<string>([memoryId]);
    const results: [Memory, Relationship][] = [];
    let currentLevel = [memoryId];

    for (let depth = 0; depth < maxDepth; depth++) {
      const nextLevel: string[] = [];

      for (const currentId of currentLevel) {
        let query = "SELECT * FROM relationships WHERE from_id = ? OR to_id = ?";
        const params: unknown[] = [currentId, currentId];

        if (relTypes && relTypes.length > 0) {
          const placeholders = relTypes.map(() => "?").join(",");
          query += ` AND rel_type IN (${placeholders})`;
          params.push(...relTypes);
        }

        const rows = this.db.prepare(query).all(...(params as any[])) as unknown as RelRow[];

        for (const row of rows) {
          const otherId = row.from_id === currentId ? row.to_id : row.from_id;
          if (visited.has(otherId)) continue;
          visited.add(otherId);
          nextLevel.push(otherId);

          const mem = await this.getMemory(otherId, false);
          if (!mem) continue;

          const props = createRelationshipProperties({
            strength: row.strength,
            confidence: row.confidence,
            context: row.context ?? undefined,
            evidence_count: row.evidence_count,
            valid_from: row.valid_from,
            valid_until: row.valid_until ?? undefined,
            recorded_at: row.recorded_at,
            invalidated_by: row.invalidated_by ?? undefined,
          });

          const rel: Relationship = {
            id: row.id,
            from_memory_id: row.from_id,
            to_memory_id: row.to_id,
            type: row.rel_type,
            properties: props,
            description: undefined,
            bidirectional: false,
          };
          results.push([mem, rel]);
        }
      }

      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    return results;
  }

  async getMemoryStatistics(): Promise<Record<string, unknown>> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");

    const totalRow = this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as Record<string, number>;
    const totalRels = this.db.prepare("SELECT COUNT(*) as count FROM relationships").get() as Record<string, number>;
    const byType = this.db
      .prepare("SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY count DESC")
      .all() as Record<string, unknown>[];
    const avgImp = this.db
      .prepare("SELECT AVG(importance) as avg_importance FROM memories")
      .get() as Record<string, number>;
    const avgConf = this.db
      .prepare("SELECT AVG(confidence) as avg_confidence FROM memories")
      .get() as Record<string, number>;

    const memoriesByType: Record<string, number> = {};
    for (const row of byType) {
      memoriesByType[row["type"] as string] = row["count"] as number;
    }

    return {
      total_memories: { count: totalRow["count"] },
      total_relationships: { count: totalRels["count"] },
      memories_by_type: memoriesByType,
      avg_importance: { avg_importance: avgImp["avg_importance"] },
      avg_confidence: { avg_confidence: avgConf["avg_confidence"] },
    };
  }

  async getRecentActivity(days = 7, project?: string | null): Promise<Record<string, unknown>> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffIso = cutoff.toISOString();

    const recentRows = this.db
      .prepare("SELECT * FROM memories WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50")
      .all(cutoffIso) as Record<string, unknown>[];

    const recentMemories = recentRows.map(rowToMemory).filter((m): m is Memory => m !== null);

    const byType: Record<string, number> = {};
    for (const mem of recentMemories) {
      byType[mem.type] = (byType[mem.type] ?? 0) + 1;
    }

    // Find unresolved problems (type=problem, no SOLVES relationship pointing to them)
    const problemRows = this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.type = 'problem'
         AND m.id NOT IN (SELECT to_id FROM relationships WHERE rel_type = 'SOLVES')
         ORDER BY m.importance DESC LIMIT 20`
      )
      .all() as Record<string, unknown>[];

    const unresolvedProblems = problemRows.map(rowToMemory).filter((m): m is Memory => m !== null);

    return {
      total_count: recentMemories.length,
      memories_by_type: byType,
      recent_memories: recentMemories,
      unresolved_problems: unresolvedProblems,
      days,
      project,
    };
  }

  async recallMemories(
    query: string,
    opts?: { memoryTypes?: string[]; projectPath?: string; limit?: number }
  ): Promise<Memory[]> {
    const searchQuery: SearchQuery = {
      query,
      terms: [],
      memory_types: opts?.memoryTypes ?? [],
      tags: [],
      project_path: opts?.projectPath,
      languages: [],
      frameworks: [],
      min_importance: undefined,
      min_confidence: undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: opts?.limit ?? 20,
      offset: 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    };
    return this.searchMemories(searchQuery);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToMemory(row: Record<string, unknown>): Memory | null {
  try {
    let context: Record<string, unknown> | undefined;
    if (row["context"]) {
      try {
        context = JSON.parse(row["context"] as string);
      } catch {
        // ignore parse errors
      }
    }

    return createMemory({
      id: row["id"] as string,
      type: row["type"] as string,
      title: row["title"] as string,
      content: row["content"] as string,
      summary: (row["summary"] as string) ?? undefined,
      tags: JSON.parse((row["tags"] as string) ?? "[]"),
      importance: (row["importance"] as number) ?? 0.5,
      confidence: (row["confidence"] as number) ?? 0.8,
      effectiveness: (row["effectiveness"] as number) ?? null,
      usage_count: (row["usage_count"] as number) ?? 0,
      created_at: row["created_at"] as string,
      updated_at: row["updated_at"] as string,
      last_accessed: (row["last_accessed"] as string) ?? undefined,
      version: (row["version"] as number) ?? 1,
      updated_by: (row["updated_by"] as string) ?? undefined,
      context,
    });
  } catch (err) {
    console.error(`Failed to parse memory row: ${err}`);
    return null;
  }
}
