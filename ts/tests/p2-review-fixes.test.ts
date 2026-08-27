/**
 * Regression tests for the 2026-08 correctness review fixes.
 *
 * VAL-REVIEW-001: MemoryDatabase.searchMemoriesPaginated capped total_count
 *   at a single 1000-row query, so paginateMemories/getAllMemories stopped
 *   after the first batch and exports/migration silently truncated at 1000.
 * VAL-REVIEW-002: SQLite storeMemory used INSERT OR REPLACE, whose delete +
 *   reinsert fires the relationships FK ON DELETE CASCADE and silently
 *   destroyed all relationships of a re-stored memory (the default path for
 *   `import` without --skip-duplicates).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SQLiteBackend } from "../src/backends/sqlite.js";
import { MemoryDatabase } from "../src/database.js";
import { createMemory, createRelationshipProperties } from "../src/models.js";
import { countMemories, getAllMemories } from "../src/utils/pagination.js";

function freshTempDir(): string {
  return mkdtempSync(
    join(tmpdir(), `mg-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`)
  );
}

describe("VAL-REVIEW-001: pagination no longer truncates at 1000", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(freshTempDir(), "review-pagination.db");
    backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    db = new MemoryDatabase(backend);

    // Seed 1000 + 7 memories: exactly one batch boundary plus a partial
    // second batch, the case where has_more previously flipped false.
    for (let i = 0; i < 1007; i++) {
      await db.storeMemory(
        createMemory({ type: "task", title: `mem ${i}`, content: `content ${i}` })
      );
    }
  }, 120_000);

  afterEach(async () => {
    await backend.disconnect();
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("getAllMemories returns every memory past the 1000 boundary", async () => {
    const all = await getAllMemories(db as any);
    expect(all.length).toBe(1007);
  }, 120_000);

  test("countMemories returns the exact total, not the capped count", async () => {
    const total = await countMemories(db as any);
    expect(total).toBe(1007);
  }, 120_000);

  test("searchMemoriesPaginated reports has_more and exact total_count", async () => {
    const page1 = await db.searchMemoriesPaginated!({
      query: undefined,
      terms: [],
      memory_types: [],
      tags: [],
      project_path: undefined,
      languages: [],
      frameworks: [],
      min_importance: undefined,
      min_confidence: undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: 1000,
      offset: 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    });
    expect(page1.results.length).toBe(1000);
    expect(page1.has_more).toBe(true);
    expect(page1.total_count).toBe(1007);
    expect(page1.next_offset).toBe(1000);
  }, 120_000);
});

describe("VAL-REVIEW-002: re-storing a memory preserves its relationships", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(freshTempDir(), "review-replace.db");
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

  test("storeMemory with an existing id keeps relationships and created_at", async () => {
    const aId = await db.storeMemory(
      createMemory({ type: "task", title: "A", content: "a" })
    );
    const bId = await db.storeMemory(
      createMemory({ type: "task", title: "B", content: "b" })
    );
    await db.createRelationship(aId, bId, "SOLVES");

    const createdBefore = (await db.getMemory(aId, false))!.created_at;

    // Re-store A with the same id — previously INSERT OR REPLACE cascaded
    // away the A→B relationship.
    await db.storeMemory(
      createMemory({ id: aId, type: "task", title: "A v2", content: "a2" })
    );

    const related = await db.getRelatedMemories(aId);
    expect(related.length).toBe(1);
    expect(related[0][1].type).toBe("SOLVES");

    const after = await db.getMemory(aId, false);
    expect(after!.title).toBe("A v2");
    expect(after!.created_at).toBe(createdBefore);
  });
});

// ---------------------------------------------------------------------------
// Later review fixes: filters, fidelity, entity links, EXISTS rewrites,
// activity, visualization, row caps, contextual search.
// ---------------------------------------------------------------------------

import { FalkorDBLiteBackend } from "../src/backends/falkordblite.js";
import { captureTaskContext } from "../src/integration/context-capture.js";
import { identifyKnowledgeGaps, getMemoryGraphVisualization } from "../src/analytics/advanced-queries.js";
import { exportToJson, importFromJson } from "../src/utils/export-import.js";
import { handleContextualSearch } from "../src/tools/search.js";
import type { SearchQuery } from "../src/models.js";

function makeQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    query: undefined,
    terms: [],
    memory_types: [],
    tags: [],
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
    ...overrides,
  };
}

async function withFalkorLite<T>(
  fn: (b: FalkorDBLiteBackend, d: MemoryDatabase) => Promise<T>
): Promise<T> {
  const dir = freshTempDir();
  const backend = new FalkorDBLiteBackend(join(dir, "fl.db"));
  try {
    await backend.connect();
    await backend.initializeSchema();
    const db = new MemoryDatabase(backend);
    return await fn(backend, db);
  } finally {
    try {
      await backend.disconnect();
    } catch {
      // ignore
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

describe("VAL-REVIEW-019: created_after/created_before/min_effectiveness honored", () => {
  test("sqlite filters by date window and effectiveness", async () => {
    const dir = freshTempDir();
    const backend = new SQLiteBackend(join(dir, "filters.db"));
    await backend.connect();
    await backend.initializeSchema();
    const db = new MemoryDatabase(backend);
    try {
      const oldMem = createMemory({
        type: "task", title: "old", content: "x",
        created_at: "2020-01-01T00:00:00.000Z",
      });
      const newMem = createMemory({
        type: "task", title: "new", content: "x", effectiveness: 0.9,
        created_at: new Date().toISOString(),
      });
      const weakMem = createMemory({
        type: "task", title: "weak", content: "x", effectiveness: 0.1,
        created_at: new Date().toISOString(),
      });
      await db.storeMemory(oldMem);
      await db.storeMemory(newMem);
      await db.storeMemory(weakMem);

      const after2021 = await db.searchMemories(makeQuery({ created_after: "2021-01-01T00:00:00.000Z" }));
      expect(after2021.map((m) => m.title).sort()).toEqual(["new", "weak"]);

      const before2021 = await db.searchMemories(makeQuery({ created_before: "2021-01-01T00:00:00.000Z" }));
      expect(before2021.map((m) => m.title)).toEqual(["old"]);

      const effective = await db.searchMemories(makeQuery({ min_effectiveness: 0.5 }));
      expect(effective.map((m) => m.title)).toEqual(["new"]);
    } finally {
      await backend.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falkordblite filters by date window and effectiveness", async () => {
    await withFalkorLite(async (_b, db) => {
      await db.storeMemory(createMemory({
        type: "task", title: "old", content: "x",
        created_at: "2020-01-01T00:00:00.000Z",
      }));
      await db.storeMemory(createMemory({
        type: "task", title: "new", content: "x", effectiveness: 0.9,
        created_at: new Date().toISOString(),
      }));
      await db.storeMemory(createMemory({
        type: "task", title: "weak", content: "x", effectiveness: 0.1,
        created_at: new Date().toISOString(),
      }));

      const after2021 = await db.searchMemories(makeQuery({ created_after: "2021-01-01T00:00:00.000Z" }));
      expect(after2021.map((m) => m.title).sort()).toEqual(["new", "weak"]);

      const effective = await db.searchMemories(makeQuery({ min_effectiveness: 0.5 }));
      expect(effective.map((m) => m.title)).toEqual(["new"]);
    });
  });
});

describe("VAL-REVIEW-023: export/import round trip preserves fidelity", () => {
  test("created_at, effectiveness, and relationship recorded_at survive", async () => {
    const dir = freshTempDir();
    const backend = new SQLiteBackend(join(dir, "rt.db"));
    await backend.connect();
    await backend.initializeSchema();
    const db = new MemoryDatabase(backend);
    const importPath = join(dir, "roundtrip.json");
    try {
      const pId = await db.storeMemory(createMemory({
        type: "problem", title: "P", content: "p",
        created_at: "2021-05-05T05:05:05.005Z",
        effectiveness: 0.7,
      }));
      const sId = await db.storeMemory(createMemory({
        type: "solution", title: "S", content: "s",
        created_at: "2021-06-06T06:06:06.006Z",
      }));
      await db.createRelationship(sId, pId, "SOLVES", createRelationshipProperties({
        strength: 0.9,
        recorded_at: "2021-07-07T07:07:07.007Z",
      }));

      await exportToJson(db, importPath);

      const restorePath = join(dir, "restore.db");
      const restoreBackend = new SQLiteBackend(restorePath);
      await restoreBackend.connect();
      await restoreBackend.initializeSchema();
      const restoreDb = new MemoryDatabase(restoreBackend);
      try {
        await importFromJson(restoreDb, importPath, true);
        const restored = await restoreDb.getMemory(pId, false);
        expect(restored?.created_at).toBe("2021-05-05T05:05:05.005Z");
        expect(restored?.effectiveness).toBe(0.7);
        const rels = await restoreDb.getRelatedMemories(pId);
        expect(rels.length).toBe(1);
        expect(rels[0][1].properties.recorded_at).toBe("2021-07-07T07:07:07.007Z");
        expect(rels[0][1].properties.strength).toBe(0.9);
      } finally {
        await restoreBackend.disconnect();
      }
    } finally {
      await backend.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("VAL-REVIEW-012: file-entity links survive repeated captures (falkordblite)", () => {
  test("second capture of the same file still creates the INVOLVES edge", async () => {
    await withFalkorLite(async (backend, _db) => {
      await captureTaskContext(backend, "task one", ["goal"], ["src/index.ts"], null);
      await captureTaskContext(backend, "task two", ["goal"], ["src/index.ts"], null);

      const result = await backend.executeQuery(
        `MATCH (t:Memory)-[r:INVOLVES]->(e:Entity {type: 'file'}) RETURN count(r) as c`
      );
      expect(result[0]?.["c"]).toBe(2);
    });
  });
});

describe("VAL-REVIEW-009: unsolved-problem queries work on FalkorDB v4.16.3", () => {
  test("identifyKnowledgeGaps returns unsolved problems and excludes solved ones", async () => {
    await withFalkorLite(async (backend, db) => {
      const p1 = await db.storeMemory(createMemory({ type: "problem", title: "unsolved", content: "p1" }));
      const p2 = await db.storeMemory(createMemory({ type: "problem", title: "solved", content: "p2" }));
      const s = await db.storeMemory(createMemory({ type: "solution", title: "fix", content: "s" }));
      await db.createRelationship(s, p2, "SOLVES");
      void p1;

      const gaps = await identifyKnowledgeGaps(backend, null);
      const topics = gaps.map((g) => g.topic);
      expect(topics).toContain("unsolved");
      expect(topics).not.toContain("solved");
    });
  });
});

describe("VAL-REVIEW-017: getRecentActivity works on falkordblite", () => {
  test("returns the stored memories instead of the empty stub", async () => {
    await withFalkorLite(async (_backend, db) => {
      await db.storeMemory(createMemory({ type: "task", title: "one", content: "1" }));
      await db.storeMemory(createMemory({ type: "task", title: "two", content: "2" }));
      await db.storeMemory(createMemory({ type: "problem", title: "prb", content: "3" }));

      const activity = await db.getRecentActivity(7, null);
      expect(activity["total_count"]).toBe(3);
      expect((activity["recent_memories"] as unknown[]).length).toBe(3);
      expect((activity["unresolved_problems"] as unknown[]).length).toBe(1);
    });
  });
});

describe("VAL-REVIEW-011: centered visualization is non-empty (falkordblite)", () => {
  test("visualize <id> returns the center and its neighbors", async () => {
    await withFalkorLite(async (backend, db) => {
      const a = await db.storeMemory(createMemory({ type: "task", title: "A", content: "a" }));
      const b = await db.storeMemory(createMemory({ type: "task", title: "B", content: "b" }));
      await db.createRelationship(a, b, "SOLVES");

      const viz = await getMemoryGraphVisualization(backend, a, 2);
      expect(viz.nodes.length).toBeGreaterThanOrEqual(2);
      expect(viz.edges.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("VAL-REVIEW-018: getRelatedMemories limit lifts the 20-row cap", () => {
  test("explicit limit returns more than the default 20 rows", async () => {
    await withFalkorLite(async (_backend, db) => {
      const hub = await db.storeMemory(createMemory({ type: "task", title: "hub", content: "h" }));
      for (let i = 0; i < 25; i++) {
        const spoke = await db.storeMemory(
          createMemory({ type: "task", title: `spoke ${i}`, content: "s" })
        );
        await db.createRelationship(hub, spoke, "RELATED_TO");
      }

      const defaultRows = await db.getRelatedMemories(hub, { maxDepth: 1 });
      expect(defaultRows.length).toBe(20);
      const lifted = await db.getRelatedMemories(hub, { maxDepth: 1, limit: 100 });
      expect(lifted.length).toBe(25);
    });
  });
});

describe("VAL-REVIEW-024: contextual search finds related matches outside the global top-N", () => {
  test("related memory ranking below the global cap is still found", async () => {
    const dir = freshTempDir();
    const backend = new SQLiteBackend(join(dir, "ctx.db"));
    await backend.connect();
    await backend.initializeSchema();
    const db = new MemoryDatabase(backend);
    try {
      // 150 high-importance memories match the query term...
      for (let i = 0; i < 150; i++) {
        await db.storeMemory(createMemory({
          type: "task", title: `zebra filler ${i}`, content: "zebra", importance: 0.9,
        }));
      }
      // ...and one low-importance related memory also matches.
      const center = await db.storeMemory(createMemory({
        type: "task", title: "center", content: "c", importance: 1.0,
      }));
      const relatedMatch = await db.storeMemory(createMemory({
        type: "solution", title: "related zebra fix", content: "zebra", importance: 0.05,
      }));
      await db.createRelationship(center, relatedMatch, "SOLVES");

      const res = await handleContextualSearch(db, {
        memory_id: center,
        query: "zebra",
        max_depth: 1,
      });
      expect(res.isError).toBe(false);
      expect(res.text).toContain("related zebra fix");
    } finally {
      await backend.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
