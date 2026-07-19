/**
 * M5 Tier 1 #9 — data-loss bug fixes (VAL-LOCAL-013/014/015/016).
 *
 * Covers:
 * - M6  (VAL-LOCAL-013): getRelatedMemories returns correct relationship
 *   direction (startNode/endNode), not always `from_memory_id: memoryId`.
 * - M12 (VAL-LOCAL-014): handleWhatChanged issues a SINGLE query filtering
 *   relationships by `recorded_at >= $since` (no N+1, no implicit 1000-cap).
 * - Activity caps (VAL-LOCAL-015): the activity command surfaces the
 *   LIMIT 50 / LIMIT 20 silent caps with a clear message instead of
 *   silently truncating.
 * - SEC-10 (VAL-LOCAL-016): SQLite LIKE queries escape `%` and `_` wildcards
 *   for tag and project_path filters so they are matched literally.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SQLiteBackend } from "../src/backends/sqlite.js";
import { FalkorDBLiteBackend } from "../src/backends/falkordblite.js";
import { MemoryDatabase } from "../src/database.js";
import {
  createMemory,
  createRelationshipProperties,
} from "../src/models.js";
import type { Relationship } from "../src/models.js";
import { handleWhatChanged } from "../src/tools/temporal.js";
import { handleGetRecentActivity } from "../src/tools/activity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshTempDir(): string {
  return mkdtempSync(
    join(tmpdir(), `mg-m5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`)
  );
}

function findRel(
  related: [unknown, Relationship][],
  fromId: string,
  toId: string,
  type: string
): Relationship | undefined {
  return related.find(([, r]) => {
    return (
      r.from_memory_id === fromId &&
      r.to_memory_id === toId &&
      r.type === type
    );
  })?.[1];
}

// ---------------------------------------------------------------------------
// M6 (VAL-LOCAL-013) — relationship direction correct on SQLite
// (SQLite already preserved direction via row.from_id/row.to_id; this is a
// regression guard.)
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-013 (M6): getRelatedMemories direction correct — SQLite", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(freshTempDir(), "m6-sqlite.db");
    backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    db = new MemoryDatabase(backend);
  });

  afterEach(async () => {
    await backend.disconnect();
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("related for B returns both directions correctly (A→B and B→C)", async () => {
    const aId = await db.storeMemory(
      createMemory({ type: "task", title: "A", content: "A content" })
    );
    const bId = await db.storeMemory(
      createMemory({ type: "task", title: "B", content: "B content" })
    );
    const cId = await db.storeMemory(
      createMemory({ type: "task", title: "C", content: "C content" })
    );

    // A → B (DEPENDS_ON): stored direction from=A, to=B
    await db.createRelationship(aId, bId, "DEPENDS_ON");
    // B → C (DEPENDS_ON): stored direction from=B, to=C
    await db.createRelationship(bId, cId, "DEPENDS_ON");

    const related = await db.getRelatedMemories(bId, { maxDepth: 1 });

    // Both A and C should appear as related to B.
    expect(related.length).toBe(2);

    // The A→B edge: from_memory_id must be A, to_memory_id must be B
    // (NOT reversed to from=B, to=A).
    const aToB = findRel(related, aId, bId, "DEPENDS_ON");
    expect(aToB).toBeDefined();
    expect(aToB!.from_memory_id).toBe(aId);
    expect(aToB!.to_memory_id).toBe(bId);

    // The B→C edge: from_memory_id must be B, to_memory_id must be C.
    const bToC = findRel(related, bId, cId, "DEPENDS_ON");
    expect(bToC).toBeDefined();
    expect(bToC!.from_memory_id).toBe(bId);
    expect(bToC!.to_memory_id).toBe(cId);
  });
});

// ---------------------------------------------------------------------------
// M6 (VAL-LOCAL-013) — relationship direction correct on falkordblite
// (This is the backend where the bug lived: the Cypher query always set
// from_memory_id = memoryId. The fix uses startNode(rel)/endNode(rel).)
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-013 (M6): getRelatedMemories direction correct — falkordblite (live)", () => {
  const STASH_PATH = process.env.MEMORY_FALKORDBLITE_PATH;

  async function withBackend<T>(fn: (b: FalkorDBLiteBackend, d: MemoryDatabase) => Promise<T>): Promise<T> {
    const dir = freshTempDir();
    process.env.MEMORY_FALKORDBLITE_PATH = join(dir, "falkordblite.db");
    const backend = new FalkorDBLiteBackend();
    try {
      await backend.connect();
      await backend.initializeSchema();
      const db = new MemoryDatabase(backend);
      return await fn(backend, db);
    } finally {
      try {
        await backend.disconnect();
      } catch {
        // best-effort
      }
      delete process.env.MEMORY_FALKORDBLITE_PATH;
      if (STASH_PATH) process.env.MEMORY_FALKORDBLITE_PATH = STASH_PATH;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  test("related for B returns both directions correctly (A→B and B→C)", async () => {
    await withBackend(async (_backend, db) => {
      const aId = await db.storeMemory(
        createMemory({ type: "task", title: "A", content: "A content", tags: ["a"] })
      );
      const bId = await db.storeMemory(
        createMemory({ type: "task", title: "B", content: "B content", tags: ["b"] })
      );
      const cId = await db.storeMemory(
        createMemory({ type: "task", title: "C", content: "C content", tags: ["c"] })
      );

      // A → B (DEPENDS_ON): stored direction from=A, to=B
      await db.createRelationship(aId, bId, "DEPENDS_ON");
      // B → C (DEPENDS_ON): stored direction from=B, to=C
      await db.createRelationship(bId, cId, "DEPENDS_ON");

      const related = await db.getRelatedMemories(bId, { maxDepth: 1 });

      // Both A and C should appear as related to B.
      expect(related.length).toBe(2);

      // The A→B edge: from_memory_id must be A, to_memory_id must be B
      // (the bug always set from_memory_id = memoryId = B, reversing the
      // incoming edge to from=B, to=A).
      const aToB = findRel(related, aId, bId, "DEPENDS_ON");
      expect(aToB).toBeDefined();
      expect(aToB!.from_memory_id).toBe(aId);
      expect(aToB!.to_memory_id).toBe(bId);

      // The B→C edge: from_memory_id must be B, to_memory_id must be C.
      const bToC = findRel(related, bId, cId, "DEPENDS_ON");
      expect(bToC).toBeDefined();
      expect(bToC!.from_memory_id).toBe(bId);
      expect(bToC!.to_memory_id).toBe(cId);
    });
  });
});

// ---------------------------------------------------------------------------
// M12 (VAL-LOCAL-014) — handleWhatChanged single query, no N+1, no 1000-cap
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-014 (M12): handleWhatChanged — single query, no truncation", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(freshTempDir(), "m12-sqlite.db");
    backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    db = new MemoryDatabase(backend);
  });

  afterEach(async () => {
    await backend.disconnect();
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("returns the full matching set without truncation (60 relationships, >1000-cap irrelevant)", async () => {
    // Create 61 memories linked in a chain: m0 -> m1 -> m2 -> ... -> m60
    // This produces 60 relationships, all recorded at "now", so a single
    // `recorded_at >= $since` query must return all 60. The old N+1 path
    // searched memories with `limit: 1000` then per-memory getRelatedMemories;
    // for >1000 memories it would silently truncate. We assert the full
    // matching set comes back regardless.
    const ids: string[] = [];
    for (let i = 0; i <= 60; i++) {
      const id = await db.storeMemory(
        createMemory({
          type: "task",
          title: `Task ${i}`,
          content: `content ${i}`,
        })
      );
      ids.push(id);
    }
    for (let i = 0; i < ids.length - 1; i++) {
      await db.createRelationship(ids[i], ids[i + 1], "DEPENDS_ON");
    }

    const since = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    const result = await handleWhatChanged(db, { since });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("New Relationships");

    // Count the relationship lines in the output. Each new relationship
    // produces a "**<n>. DEPENDS_ON**" header line.
    const relLines = result.text.match(/\*\*\d+\.\s+DEPENDS_ON\*\*/g) ?? [];
    expect(relLines.length).toBe(60);

    // And explicitly verify no truncation message hides the count.
    expect(result.text).not.toContain("limit");
    expect(result.text).not.toContain("truncat");
  });

  test("returns 'No relationship changes found' when nothing matches", async () => {
    const aId = await db.storeMemory(
      createMemory({ type: "task", title: "A", content: "a" })
    );
    const bId = await db.storeMemory(
      createMemory({ type: "task", title: "B", content: "b" })
    );
    await db.createRelationship(aId, bId, "DEPENDS_ON");

    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const result = await handleWhatChanged(db, { since: future });
    expect(result.text).toContain("No relationship changes found");
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-015 — activity LIMIT caps surfaced (not silent)
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-015: activity LIMIT caps surfaced with a clear message", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(freshTempDir(), "act-sqlite.db");
    backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    db = new MemoryDatabase(backend);
  });

  afterEach(async () => {
    await backend.disconnect();
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("when recent memories exceed LIMIT 50, output surfaces a cap message", async () => {
    // Store 55 memories — exceeds the LIMIT 50 cap on recent_memories.
    for (let i = 0; i < 55; i++) {
      await db.storeMemory(
        createMemory({
          type: "solution",
          title: `Solution ${i}`,
          content: `content ${i}`,
        })
      );
    }

    const result = await handleGetRecentActivity(db, { days: 7 });

    // The output must surface (not silently truncate) that results are capped.
    // Accept any clear cap/limited/truncated wording.
    const capPattern = /capped|limited|truncat/i;
    expect(capPattern.test(result.text)).toBe(true);
  });

  test("when unresolved problems exceed LIMIT 20, output surfaces a cap message", async () => {
    // Store 25 problems with no solutions — exceeds LIMIT 20 on
    // unresolved_problems.
    for (let i = 0; i < 25; i++) {
      await db.storeMemory(
        createMemory({
          type: "problem",
          title: `Problem ${i}`,
          content: `content ${i}`,
          importance: 0.5,
        })
      );
    }

    const result = await handleGetRecentActivity(db, { days: 7 });
    const capPattern = /capped|limited|truncat/i;
    expect(capPattern.test(result.text)).toBe(true);
  });

  test("when under the caps, no cap message is surfaced", async () => {
    for (let i = 0; i < 5; i++) {
      await db.storeMemory(
        createMemory({
          type: "solution",
          title: `Solution ${i}`,
          content: `content ${i}`,
        })
      );
    }
    const result = await handleGetRecentActivity(db, { days: 7 });
    const capPattern = /capped|limited|truncat/i;
    expect(capPattern.test(result.text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEC-10 (VAL-LOCAL-016) — SQLite LIKE wildcard escape for tag + project_path
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-016 (SEC-10): SQLite LIKE escapes % and _ wildcards", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(freshTempDir(), "sec10-sqlite.db");
    backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    db = new MemoryDatabase(backend);
  });

  afterEach(async () => {
    await backend.disconnect();
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("a tag containing % and _ is matched literally", async () => {
    // Memory with a tag that contains literal % and _ wildcard characters.
    const literalId = await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Literal wildcard tag",
        content: "content with literal percent and underscore in tag",
        tags: ["50%_off"],
      })
    );
    // A decoy whose tag would match the unescaped LIKE pattern (because %
    // matches "x" and _ matches "" — i.e. "50xoff" matches "50%_off" when
    // % and _ are treated as wildcards).
    const decoyId = await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Decoy tag",
        content: "decoy content",
        tags: ["50xoff"],
      })
    );

    const results = await db.searchMemories({
      query: undefined,
      terms: [],
      memory_types: [],
      tags: ["50%_off"],
      project_path: undefined,
      languages: [],
      frameworks: [],
      min_importance: undefined,
      min_confidence: undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: 50,
      offset: 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    });

    const ids = results.map((m) => m.id);
    expect(ids).toContain(literalId);
    expect(ids).not.toContain(decoyId);
  });

  test("a project_path containing % and _ is matched literally", async () => {
    const literalId = await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Literal wildcard project_path",
        content: "content with literal percent and underscore in project_path",
        context: { project_path: "/repo/50%_off/path_qux" },
      })
    );
    // Decoy: "/repo/50Xoff/pathQqux" would match the unescaped pattern
    // (% matches X, _ matches Q).
    const decoyId = await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Decoy project_path",
        content: "decoy content",
        context: { project_path: "/repo/50Xoff/pathQqux" },
      })
    );

    const results = await db.searchMemories({
      query: undefined,
      terms: [],
      memory_types: [],
      tags: [],
      project_path: "/repo/50%_off/path_qux",
      languages: [],
      frameworks: [],
      min_importance: undefined,
      min_confidence: undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: 50,
      offset: 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    });

    const ids = results.map((m) => m.id);
    expect(ids).toContain(literalId);
    expect(ids).not.toContain(decoyId);
  });
});
