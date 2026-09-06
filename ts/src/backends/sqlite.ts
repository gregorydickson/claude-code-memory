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
      const syncMode = (process.env["MEMORY_SQLITE_SYNCHRONOUS"] ?? "NORMAL").toUpperCase();
      const safeSyncMode = ["OFF", "NORMAL", "FULL", "EXTRA"].includes(syncMode) ? syncMode : "NORMAL";
      this.db.exec(`PRAGMA synchronous=${safeSyncMode};`);
      this.db.exec("PRAGMA temp_store=MEMORY;");
      this.db.exec("PRAGMA mmap_size=67108864;");
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

      -- Full-Text Search (FTS5) with Porter stemming and unicode support
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        title,
        content,
        summary,
        tags,
        tokenize = 'porter unicode61'
      );

      -- Triggers keeping FTS index in lockstep with memories table
      CREATE TRIGGER IF NOT EXISTS trg_memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id, title, content, summary, tags)
        VALUES (new.id, new.title, new.content, COALESCE(new.summary, ''), new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_memories_au AFTER UPDATE ON memories
      WHEN old.title IS NOT new.title
        OR old.content IS NOT new.content
        OR old.summary IS NOT new.summary
        OR old.tags IS NOT new.tags
      BEGIN
        DELETE FROM memories_fts WHERE id = old.id;
        INSERT INTO memories_fts(id, title, content, summary, tags)
        VALUES (new.id, new.title, new.content, COALESCE(new.summary, ''), new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_memories_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE id = old.id;
      END;

      -- Backfill FTS for any pre-existing rows
      INSERT INTO memories_fts(id, title, content, summary, tags)
      SELECT m.id, m.title, m.content, COALESCE(m.summary, ''), m.tags
      FROM memories m
      WHERE NOT EXISTS (SELECT 1 FROM memories_fts f WHERE f.id = m.id);
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
    return true;
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
    const now = new Date().toISOString();
    if (!memory.id) memory.id = randomUUID();
    const createdAt = memory.created_at ? toIso(memory.created_at) : now;
    const updatedAt = memory.updated_at ? toIso(memory.updated_at) : now;
    memory.updated_at = updatedAt;

    const contextJson = memory.context ? JSON.stringify(memory.context) : null;

    try {
      // Upsert via ON CONFLICT DO UPDATE — NOT INSERT OR REPLACE. REPLACE
      // deletes + reinserts the row, which fires the relationships FK
      // ON DELETE CASCADE (PRAGMA foreign_keys=ON) and silently destroys
      // every relationship of an existing memory (VAL-REVIEW-002). The
      // upsert updates in place, preserving relationships. `created_at`
      // keeps its original value on conflict: creation time is immutable
      // identity, and importFromJson relies on it surviving re-import.
      this.db
        .prepare(
          `INSERT INTO memories
           (id, type, title, content, summary, tags, importance, confidence, effectiveness,
            usage_count, created_at, updated_at, last_accessed, version, updated_by, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             type = excluded.type,
             title = excluded.title,
             content = excluded.content,
             summary = excluded.summary,
             tags = excluded.tags,
             importance = excluded.importance,
             confidence = excluded.confidence,
             effectiveness = excluded.effectiveness,
             usage_count = excluded.usage_count,
             updated_at = excluded.updated_at,
             last_accessed = excluded.last_accessed,
             version = excluded.version,
             updated_by = excluded.updated_by,
             context = excluded.context`
        )
        .run(
          memory.id,
          memory.type,
          memory.title,
          memory.content,
          memory.summary ?? null,
          JSON.stringify(Array.isArray(memory.tags) ? memory.tags : []),
          typeof memory.importance === "number" ? memory.importance : 0.5,
          typeof memory.confidence === "number" ? memory.confidence : 0.8,
          memory.effectiveness ?? null,
          typeof memory.usage_count === "number" ? memory.usage_count : 0,
          createdAt,
          updatedAt,
          memory.last_accessed ? toIso(memory.last_accessed) : null,
          typeof memory.version === "number" ? memory.version : 1,
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

  /**
   * High-throughput batch ingestion using SQLite prepared statements inside a single transaction.
   */
  async bulkStoreMemories(memories: Memory[]): Promise<string[]> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");
    if (memories.length === 0) return [];

    const ids: string[] = [];
    const now = new Date().toISOString();

    const insertStmt = this.db.prepare(
      `INSERT INTO memories
       (id, type, title, content, summary, tags, importance, confidence, effectiveness,
        usage_count, created_at, updated_at, last_accessed, version, updated_by, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         title = excluded.title,
         content = excluded.content,
         summary = excluded.summary,
         tags = excluded.tags,
         importance = excluded.importance,
         confidence = excluded.confidence,
         effectiveness = excluded.effectiveness,
         usage_count = excluded.usage_count,
         updated_at = excluded.updated_at,
         last_accessed = excluded.last_accessed,
         version = excluded.version,
         updated_by = excluded.updated_by,
         context = excluded.context`
    );

    try {
      this.db.exec("BEGIN TRANSACTION;");
      for (const memory of memories) {
        const memId = memory.id || randomUUID();
        memory.id = memId;
        const createdAt = memory.created_at ? toIso(memory.created_at) : now;
        const updatedAt = memory.updated_at ? toIso(memory.updated_at) : now;
        memory.updated_at = updatedAt;
        ids.push(memId);

        const contextJson = memory.context ? JSON.stringify(memory.context) : null;
        insertStmt.run(
          memId,
          memory.type,
          memory.title,
          memory.content,
          memory.summary ?? null,
          JSON.stringify(Array.isArray(memory.tags) ? memory.tags : []),
          typeof memory.importance === "number" ? memory.importance : 0.5,
          typeof memory.confidence === "number" ? memory.confidence : 0.8,
          memory.effectiveness ?? null,
          typeof memory.usage_count === "number" ? memory.usage_count : 0,
          createdAt,
          updatedAt,
          memory.last_accessed ? toIso(memory.last_accessed) : null,
          typeof memory.version === "number" ? memory.version : 1,
          memory.updated_by ?? null,
          contextJson
        );
      }
      this.db.exec("COMMIT;");
      return ids;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      console.error(`Failed to bulk store memories: ${err}`);
      throw new DatabaseConnectionError(`Failed to bulk store memories: ${err}`);
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

    // 1. High-Performance FTS5 Search Path (with Porter stemming and BM25 ranking)
    // Used when a text query is present without explicit override terms.
    if (searchQuery.query && (!searchQuery.terms || searchQuery.terms.length === 0)) {
      const tokens = tokenizeSearchQuery(searchQuery.query);
      if (tokens.length > 0) {
        try {
          const ftsConditions: string[] = [];
          const ftsParams: unknown[] = [];

          const joiner = searchQuery.match_mode === "all" ? " AND " : " OR ";
          const ftsMatch = tokens.map((w) => `"${w.replace(/"/g, '""')}"*`).join(joiner);

          ftsConditions.push("memories_fts MATCH ?");
          ftsParams.push(ftsMatch);

          if (searchQuery.memory_types.length > 0) {
            const placeholders = searchQuery.memory_types.map(() => "?").join(",");
            ftsConditions.push(`m.type IN (${placeholders})`);
            ftsParams.push(...searchQuery.memory_types);
          }

          if (searchQuery.tags.length > 0) {
            const tagConditions = searchQuery.tags.map(() => "m.tags LIKE ? ESCAPE '\\'").join(" OR ");
            ftsConditions.push(`(${tagConditions})`);
            for (const tag of searchQuery.tags) {
              ftsParams.push(`%"${escapeLikeLiteral(tag)}"%`);
            }
          }

          if (searchQuery.project_path) {
            ftsConditions.push("json_extract(m.context, '$.project_path') = ?");
            ftsParams.push(searchQuery.project_path);
          }

          if (searchQuery.min_importance !== undefined && searchQuery.min_importance !== null) {
            ftsConditions.push("m.importance >= ?");
            ftsParams.push(searchQuery.min_importance);
          }

          if (searchQuery.min_confidence !== undefined && searchQuery.min_confidence !== null) {
            ftsConditions.push("m.confidence >= ?");
            ftsParams.push(searchQuery.min_confidence);
          }

          if (searchQuery.min_effectiveness !== undefined && searchQuery.min_effectiveness !== null) {
            ftsConditions.push("m.effectiveness >= ?");
            ftsParams.push(searchQuery.min_effectiveness);
          }

          if (searchQuery.created_after) {
            ftsConditions.push("m.created_at >= ?");
            ftsParams.push(
              searchQuery.created_after instanceof Date
                ? searchQuery.created_after.toISOString()
                : searchQuery.created_after
            );
          }

          if (searchQuery.created_before) {
            ftsConditions.push("m.created_at <= ?");
            ftsParams.push(
              searchQuery.created_before instanceof Date
                ? searchQuery.created_before.toISOString()
                : searchQuery.created_before
            );
          }

          const ftsWhere = ftsConditions.join(" AND ");
          // Weights for memories_fts columns: id (unindexed), title, content, summary, tags
          // Graph-aware reranking: proportional boost (1.25x) for authoritative nodes with active relationships
          const ftsSql = `
            SELECT m.*,
                   (bm25(memories_fts, 0.0, 10.0, 1.0, 2.0, 3.0) * (
                     CASE WHEN EXISTS (
                       SELECT 1 FROM relationships r
                       WHERE (r.from_id = m.id OR r.to_id = m.id)
                         AND (r.rel_type IN ('SOLVES', 'BUILDS_ON', 'REQUIRES', 'PREVENTS') OR r.strength >= 0.7)
                     ) THEN 1.25 ELSE 1.0 END
                   )) AS fts_score
            FROM memories_fts f
            JOIN memories m ON m.id = f.id
            WHERE ${ftsWhere}
            ORDER BY fts_score ASC, m.importance DESC, m.created_at DESC
            LIMIT ? OFFSET ?
          `;

          const boundFts = [...ftsParams, searchQuery.limit, searchQuery.offset ?? 0];
          const ftsRows = this.db.prepare(ftsSql).all(...boundFts) as Record<string, unknown>[];

          return ftsRows.map(rowToMemory).filter((m): m is Memory => m !== null);
        } catch {
          // Fallback to tokenized LIKE search below on FTS syntax or query execution failure
        }
      }
    }

    // 2. Tokenized LIKE search fallback
    const conditions: string[] = [];
    const params: unknown[] = [];

    let relevanceSql = "0";
    const relevanceParams: unknown[] = [];

    const phrase = searchQuery.query ? `%${escapeLikeValue(searchQuery.query)}%` : undefined;
    const explicitTerms = normalizeSearchTerms(searchQuery.terms);
    const terms =
      explicitTerms.length > 0
        ? explicitTerms
        : searchQuery.query
          ? tokenizeSearchQuery(searchQuery.query)
          : [];
    const termsCameFromQuery = explicitTerms.length === 0;

    if (terms.length > 0) {
      const joiner = searchQuery.match_mode === "all" ? " AND " : " OR ";
      const termConditions: string[] = [];
      const scoreParts: string[] = [];

      for (const term of terms) {
        const pattern = `%${escapeLikeValue(term)}%`;
        termConditions.push(
          `(title ${LIKE} OR content ${LIKE} OR summary ${LIKE} OR tags ${LIKE})`
        );
        params.push(pattern, pattern, pattern, pattern);

        scoreParts.push(
          `(CASE WHEN title ${LIKE} THEN 4 ELSE 0 END)`,
          `(CASE WHEN tags ${LIKE} THEN 3 ELSE 0 END)`,
          `(CASE WHEN summary ${LIKE} THEN 2 ELSE 0 END)`,
          `(CASE WHEN content ${LIKE} THEN 1 ELSE 0 END)`
        );
        relevanceParams.push(pattern, pattern, pattern, pattern);
      }

      conditions.push(`(${termConditions.join(joiner)})`);

      if (phrase !== undefined && termsCameFromQuery) {
        scoreParts.push(
          `(CASE WHEN title ${LIKE} THEN 12 ELSE 0 END)`,
          `(CASE WHEN content ${LIKE} THEN 6 ELSE 0 END)`
        );
        relevanceParams.push(phrase, phrase);
      }

      relevanceSql = scoreParts.join(" + ");
    } else if (phrase !== undefined) {
      conditions.push(`(title ${LIKE} OR content ${LIKE} OR summary ${LIKE})`);
      params.push(phrase, phrase, phrase);
    }

    if (searchQuery.memory_types.length > 0) {
      const placeholders = searchQuery.memory_types.map(() => "?").join(",");
      conditions.push(`type IN (${placeholders})`);
      params.push(...searchQuery.memory_types);
    }

    if (searchQuery.tags.length > 0) {
      // SEC-10 (VAL-LOCAL-016): escape `%` and `_` wildcards in the
      // user-supplied tag values so they are matched literally, not as
      // SQL LIKE wildcards. Without this, a tag like "50%_off" would also
      // match "50xoff" (because `%` matches "x" and `_` matches "").
      // We keep the OUTER `%` wildcards (intentional prefix/suffix match
      // against the JSON blob) but escape any `%`/`_` inside the tag.
      const tagConditions = searchQuery.tags.map(() => "tags LIKE ? ESCAPE '\\'").join(" OR ");
      conditions.push(`(${tagConditions})`);
      for (const tag of searchQuery.tags) {
        params.push(`%"${escapeLikeLiteral(tag)}"%`);
      }
    }

    if (searchQuery.project_path) {
      // L3 (VAL-P2-003): filter project_path via `json_extract` (extract the
      // field from the JSON context blob BEFORE comparison) instead of a
      // brittle LIKE against the raw JSON blob. `json_extract` is
      // supported by both `node:sqlite` (Node v24) and `bun:sqlite`
      // (SQLite 3.38+) and matches the project_path exactly, so no LIKE
      // wildcard escaping is needed here (the SEC-10 escapeLikeLiteral
      // helper is still used for the tag LIKE filter above). This is also
      // robust to JSON whitespace / key-ordering differences in the stored
      // context blob that the previous raw-blob substring match would miss.
      conditions.push("json_extract(context, '$.project_path') = ?");
      params.push(searchQuery.project_path);
    }

    if (searchQuery.min_importance !== undefined && searchQuery.min_importance !== null) {
      conditions.push("importance >= ?");
      params.push(searchQuery.min_importance);
    }

    if (searchQuery.min_confidence !== undefined && searchQuery.min_confidence !== null) {
      conditions.push("confidence >= ?");
      params.push(searchQuery.min_confidence);
    }

    // VAL-REVIEW-019: honor the date/effectiveness filters the schema
    // promises (previously silently ignored).
    if (searchQuery.min_effectiveness !== undefined && searchQuery.min_effectiveness !== null) {
      conditions.push("effectiveness >= ?");
      params.push(searchQuery.min_effectiveness);
    }

    if (searchQuery.created_after) {
      conditions.push("created_at >= ?");
      params.push(
        searchQuery.created_after instanceof Date
          ? searchQuery.created_after.toISOString()
          : searchQuery.created_after
      );
    }

    if (searchQuery.created_before) {
      conditions.push("created_at <= ?");
      params.push(
        searchQuery.created_before instanceof Date
          ? searchQuery.created_before.toISOString()
          : searchQuery.created_before
      );
    }

    const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
    const boundParams = [
      ...relevanceParams,
      ...params,
      searchQuery.limit,
      searchQuery.offset ?? 0,
    ];

    // Rank memories by combining lexical relevance score (title/content/summary/tags)
    // with a graph connectivity boost (+1.0) when the memory participates in critical
    // causal or high-strength semantic relationships (SOLVES, BUILDS_ON, REQUIRES, PREVENTS).
    // Break ties by inherent importance, then recency.
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, (${relevanceSql} + (
             CASE WHEN EXISTS (
               SELECT 1 FROM relationships r
               WHERE (r.from_id = memories.id OR r.to_id = memories.id)
                 AND (r.rel_type IN ('SOLVES', 'BUILDS_ON', 'REQUIRES', 'PREVENTS') OR r.strength >= 0.7)
             ) THEN 1.0 ELSE 0.0 END
           )) AS relevance FROM memories WHERE ${whereClause}
         ) ORDER BY relevance DESC, importance DESC, created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...(boundParams as any[])) as Record<string, unknown>[];

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
    const props = createRelationshipProperties(properties);

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
    opts?: { relationshipTypes?: string[]; maxDepth?: number; limit?: number }
  ): Promise<[Memory, Relationship][]> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");
    const maxDepth = Math.max(1, Math.min(Number(opts?.maxDepth ?? 2) || 2, 10));
    const relTypes = opts?.relationshipTypes;

    // For shallow traversals (maxDepth <= 2, covering standard agent recall), execute
    // via single-query recursive CTE in SQLite C engine for sub-millisecond latency.
    // For deeper traversals (maxDepth > 2), delegate to procedural BFS with a global
    // visited Set to avoid combinatorial diamond-path replication on dense DAGs.
    if (maxDepth > 2) {
      return this._fallbackBfs(memoryId, opts);
    }

    try {
      let relTypeFilter = "";
      const relParams: unknown[] = [];

      // Single-query multi-hop graph exploration via a recursive CTE (WITH RECURSIVE).
      // Traverses incoming/outgoing relationships up to maxDepth directly within SQLite,
      // orders results by depth and strength, deduplicates visited nodes, and constructs
      // typed Memory and Relationship models, with fallback to iterative BFS on error.
      if (relTypes && relTypes.length > 0) {
        const placeholders = relTypes.map(() => "?").join(",");
        relTypeFilter = `AND r.rel_type IN (${placeholders})`;
        relParams.push(...relTypes);
      }

      // Single-query recursive BFS traversal in SQLite C engine with cycle tracking.
      // Memory IDs in path segments are hex-encoded (hex(?)) to guarantee delimiter isolation:
      // if an ID contains literal commas (e.g. "a,b"), raw comma concatenation produces ",root,a,b,"
      // where a distinct child node "b" would falsely match instr(path, ",b,"). Hex encoding restricts
      // path tokens strictly to [0-9A-F], eliminating delimiter collision.
      const sql = `
        WITH RECURSIVE traverse(mem_id, rel_id, depth, path) AS (
          SELECT
            CAST(? AS TEXT) AS mem_id,
            CAST(NULL AS TEXT) AS rel_id,
            0 AS depth,
            ',' || hex(?) || ',' AS path

          UNION

          SELECT
            CASE WHEN r.from_id = t.mem_id THEN r.to_id ELSE r.from_id END AS mem_id,
            r.id AS rel_id,
            t.depth + 1 AS depth,
            t.path || hex(CASE WHEN r.from_id = t.mem_id THEN r.to_id ELSE r.from_id END) || ',' AS path
          FROM relationships r
          JOIN traverse t ON (r.from_id = t.mem_id OR r.to_id = t.mem_id)
          WHERE t.depth < ?
            AND instr(t.path, ',' || hex(CASE WHEN r.from_id = t.mem_id THEN r.to_id ELSE r.from_id END) || ',') = 0
            ${relTypeFilter}
        )
        SELECT DISTINCT
          t.depth,
          r.id AS r_id, r.from_id, r.to_id, r.rel_type, r.strength, r.confidence AS r_confidence, r.context AS r_context,
          r.evidence_count, r.valid_from, r.valid_until, r.recorded_at AS r_recorded_at, r.invalidated_by,
          m.id, m.type, m.title, m.content, m.summary, m.tags, m.importance, m.confidence,
          m.effectiveness, m.usage_count, m.created_at, m.updated_at, m.last_accessed, m.version,
          m.updated_by, m.context
        FROM traverse t
        JOIN relationships r ON r.id = t.rel_id
        JOIN memories m ON m.id = t.mem_id
        WHERE t.depth > 0
        ORDER BY t.depth ASC, r.strength DESC;
      `;

      const queryParams = [
        memoryId, memoryId, maxDepth, ...relParams,
      ];

      const rows = this.db.prepare(sql).all(...(queryParams as any[])) as Record<string, unknown>[];
      const results: [Memory, Relationship][] = [];
      const seenNodes = new Set<string>([memoryId]);

      for (const row of rows) {
        const otherId = row["id"] as string;
        if (seenNodes.has(otherId)) continue;
        seenNodes.add(otherId);

        const mem = rowToMemory(row);
        if (!mem) continue;

        const props = createRelationshipProperties({
          strength: Number(row["strength"] ?? 0.5),
          confidence: Number(row["r_confidence"] ?? 0.8),
          context: (row["r_context"] as string) ?? undefined,
          evidence_count: Number(row["evidence_count"] ?? 1),
          valid_from: row["valid_from"] as string,
          valid_until: (row["valid_until"] as string) ?? undefined,
          recorded_at: row["r_recorded_at"] as string,
          invalidated_by: (row["invalidated_by"] as string) ?? undefined,
        });

        const rel: Relationship = {
          id: row["r_id"] as string,
          from_memory_id: row["from_id"] as string,
          to_memory_id: row["to_id"] as string,
          type: row["rel_type"] as string,
          properties: props,
          description: undefined,
          bidirectional: false,
        };
        results.push([mem, rel]);
      }

      // VAL-REVIEW-018: honor opts.limit when provided (Cypher backends cap
      // at 20 by default); sqlite historically returned everything, so the
      // default here remains uncapped for behavior parity.
      if (opts?.limit !== undefined) {
        return results.slice(0, Math.max(0, Math.trunc(opts.limit)));
      }
      return results;
    } catch {
      return this._fallbackBfs(memoryId, opts);
    }
  }

  private async _fallbackBfs(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number; limit?: number }
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

        query += " ORDER BY strength DESC";

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

    // VAL-REVIEW-018: honor opts.limit when provided (Cypher backends cap
    // at 20 by default); sqlite historically returned everything, so the
    // default here remains uncapped for behavior parity.
    if (opts?.limit !== undefined) {
      return results.slice(0, Math.max(0, Math.trunc(opts.limit)));
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

    // VAL-LOCAL-015: surface the LIMIT 50 / LIMIT 20 silent caps with a
    // clear message instead of silently truncating. We fetch the true
    // totals with cheap COUNT(*) queries and compare them to the capped
    // returned counts, then emit a human-readable `cap_message` the
    // activity handler surfaces in its output.
    const RECENT_CAP = 50;
    const UNRESOLVED_CAP = 20;

    const recentRows = this.db
      .prepare("SELECT * FROM memories WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?")
      .all(cutoffIso, RECENT_CAP) as Record<string, unknown>[];

    const recentMemories = recentRows.map(rowToMemory).filter((m): m is Memory => m !== null);

    const recentTotalRow = this.db
      .prepare("SELECT COUNT(*) as count FROM memories WHERE created_at >= ?")
      .get(cutoffIso) as Record<string, number>;
    const recentTotal = recentTotalRow["count"] ?? 0;

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
         ORDER BY m.importance DESC LIMIT ?`
      )
      .all(UNRESOLVED_CAP) as Record<string, unknown>[];

    const unresolvedProblems = problemRows.map(rowToMemory).filter((m): m is Memory => m !== null);

    const unresolvedTotalRow = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM memories m
         WHERE m.type = 'problem'
         AND m.id NOT IN (SELECT to_id FROM relationships WHERE rel_type = 'SOLVES')`
      )
      .get() as Record<string, number>;
    const unresolvedTotal = unresolvedTotalRow["count"] ?? 0;

    const recentCapped = recentTotal > recentMemories.length;
    const unresolvedCapped = unresolvedTotal > unresolvedProblems.length;

    const capParts: string[] = [];
    if (recentCapped) {
      capParts.push(
        `Recent memories capped at ${RECENT_CAP} (${recentTotal} total in the last ${days} days)`
      );
    }
    if (unresolvedCapped) {
      capParts.push(
        `Unresolved problems capped at ${UNRESOLVED_CAP} (${unresolvedTotal} total)`
      );
    }
    const capMessage = capParts.length > 0 ? capParts.join("; ") : null;

    return {
      total_count: recentMemories.length,
      memories_by_type: byType,
      recent_memories: recentMemories,
      recent_memories_total: recentTotal,
      recent_memories_capped: recentCapped,
      unresolved_problems: unresolvedProblems,
      unresolved_problems_total: unresolvedTotal,
      unresolved_problems_capped: unresolvedCapped,
      cap_message: capMessage,
      days,
      project,
    };
  }

  /**
   * M12 (VAL-LOCAL-014): single SQL query filtering relationships by
   * `recorded_at >= ?`. Replaces the N+1 per-memory loop in
   * `handleWhatChanged` (which also implicitly capped at 1000 memories via
   * `searchMemories({limit: 1000})`). Returns the full matching set with no
   * truncation.
   */
  async getRelationshipsSince(since: Date): Promise<Relationship[]> {
    if (!this.db) throw new DatabaseConnectionError("Not connected");
    const sinceIso = since instanceof Date ? since.toISOString() : String(since);
    const rows = this.db
      .prepare(
        `SELECT * FROM relationships
         WHERE recorded_at >= ? OR (valid_until IS NOT NULL AND valid_until >= ?)
         ORDER BY recorded_at ASC`
      )
      .all(sinceIso, sinceIso) as unknown as RelRow[];

    const relationships: Relationship[] = [];
    for (const row of rows) {
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
      relationships.push({
        id: row.id,
        from_memory_id: row.from_id,
        to_memory_id: row.to_id,
        type: row.rel_type,
        properties: props,
        description: undefined,
        bidirectional: false,
      });
    }
    return relationships;
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

const SEARCH_STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "for", "from",
  "how", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "was",
  "were", "what", "when", "where", "which", "who", "why", "with",
]);

const MAX_SEARCH_TERMS = 12;

const LIKE_ESCAPE_CHAR = "\\";

const LIKE = `LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`;

/**
 * Escape the LIKE wildcards `%` and `_` so a value is compared literally.
 *
 * Pair with the {@link LIKE} operator fragment, which supplies the matching
 * ESCAPE clause.
 */
function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `${LIKE_ESCAPE_CHAR}${char}`);
}

/**
 * Normalize a caller-supplied list of search terms.
 *
 * Trims and lowercases each entry, discards empty ones, de-duplicates, and
 * caps the result at {@link MAX_SEARCH_TERMS} so the generated SQL stays
 * within SQLite's expression limits.
 */
function normalizeSearchTerms(terms: string[]): string[] {
  const normalized = new Set<string>();
  for (const term of terms) {
    const trimmed = term.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    normalized.add(trimmed);
    if (normalized.size >= MAX_SEARCH_TERMS) break;
  }
  return [...normalized];
}

/**
 * Split a natural-language query into search terms.
 *
 * Retains intra-word punctuation so dotted, hyphenated and underscored
 * identifiers survive as single terms, discards stopwords and single
 * characters, de-duplicates, and caps the result at {@link MAX_SEARCH_TERMS}.
 * Returns an empty array when nothing usable remains, leaving the caller to
 * fall back to matching the raw query string.
 */
function tokenizeSearchQuery(query: string): string[] {
  const terms = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}_.\-/]+/u)) {
    const term = raw.replace(/^[.\-/]+|[.\-/]+$/g, "");
    if (term.length < 2 || SEARCH_STOPWORDS.has(term)) continue;
    terms.add(term);
    if (terms.size >= MAX_SEARCH_TERMS) break;
  }
  return [...terms];
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * SEC-10 (VAL-LOCAL-016): escape `%`, `_`, and `\` (the escape char itself)
 * in a literal substring that will be interpolated into a SQLite LIKE
 * pattern. Used with the `ESCAPE '\'` clause so user-supplied tag and
 * project_path values are matched literally, not as SQL LIKE wildcards.
 *
 * Example: `50%_off` → `50\%\_off` (matched literally by `LIKE '%50\%\_off%' ESCAPE '\'`).
 */
function escapeLikeLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
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
