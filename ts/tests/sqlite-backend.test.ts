/**
 * Tests for the SQLite backend.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteBackend } from "../src/backends/sqlite.js";
import { MemoryDatabase } from "../src/database.js";
import { createMemory, createRelationshipProperties } from "../src/models.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB = join(tmpdir(), `mg-test-${Date.now()}.db`);

describe("SQLiteBackend", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;

  beforeEach(async () => {
    backend = new SQLiteBackend(TEST_DB);
    await backend.connect();
    await backend.initializeSchema();
    db = new MemoryDatabase(backend);
  });

  afterEach(async () => {
    await backend.disconnect();
    try {
      if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    } catch {
      // ignore
    }
  });

  test("connects and initializes schema", () => {
    expect(backend.backendName()).toBe("sqlite");
    expect(backend.isCypherCapable()).toBe(false);
  });

  test("stores and retrieves a memory", async () => {
    const mem = createMemory({
      type: "solution",
      title: "Test Solution",
      content: "Use retry logic for timeouts",
      tags: ["redis", "timeout"],
      importance: 0.8,
    });

    const id = await db.storeMemory(mem);
    expect(id).toBeDefined();

    const retrieved = await db.getMemory(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Test Solution");
    expect(retrieved!.content).toBe("Use retry logic for timeouts");
    expect(retrieved!.tags).toEqual(["redis", "timeout"]);
    expect(retrieved!.importance).toBe(0.8);
  });

  test("searches memories by query", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "Redis fix", content: "Fixed Redis timeout" })
    );
    await db.storeMemory(
      createMemory({ type: "problem", title: "Auth bug", content: "JWT validation failing" })
    );

    const results = await db.searchMemories({
      query: "Redis",
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
    });

    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Redis fix");
  });

  test("searches memories by tags", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "Tagged memory", content: "Content", tags: ["redis", "fix"] })
    );
    await db.storeMemory(
      createMemory({ type: "solution", title: "Untagged memory", content: "Content" })
    );

    const results = await db.searchMemories({
      query: undefined,
      terms: [],
      memory_types: [],
      tags: ["redis"],
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

    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Tagged memory");
  });

  test("updates a memory", async () => {
    const mem = createMemory({ type: "solution", title: "Original", content: "Original content" });
    const id = await db.storeMemory(mem);

    const retrieved = await db.getMemory(id);
    retrieved!.title = "Updated title";
    const success = await db.updateMemory(retrieved!);
    expect(success).toBe(true);

    const updated = await db.getMemory(id);
    expect(updated!.title).toBe("Updated title");
  });

  test("deletes a memory", async () => {
    const mem = createMemory({ type: "solution", title: "To delete", content: "Content" });
    const id = await db.storeMemory(mem);

    const success = await db.deleteMemory(id);
    expect(success).toBe(true);

    const retrieved = await db.getMemory(id);
    expect(retrieved).toBeNull();
  });

  test("creates and retrieves relationships", async () => {
    const problemId = await db.storeMemory(
      createMemory({ type: "problem", title: "Problem", content: "A problem" })
    );
    const solutionId = await db.storeMemory(
      createMemory({ type: "solution", title: "Solution", content: "A solution" })
    );

    const relId = await db.createRelationship(
      solutionId,
      problemId,
      "SOLVES",
      createRelationshipProperties({ strength: 0.9 })
    );
    expect(relId).toBeDefined();

    const related = await db.getRelatedMemories(solutionId, { maxDepth: 1 });
    expect(related.length).toBe(1);
    expect(related[0][0].title).toBe("Problem");
    expect(related[0][1].type).toBe("SOLVES");
    expect(related[0][1].properties.strength).toBe(0.9);
  });

  test("getMemoryStatistics returns correct stats", async () => {
    await db.storeMemory(createMemory({ type: "solution", title: "S1", content: "C1" }));
    await db.storeMemory(createMemory({ type: "problem", title: "P1", content: "C2" }));

    const stats = await db.getMemoryStatistics();
    const totalMem = stats["total_memories"] as Record<string, unknown>;
    expect(totalMem["count"]).toBe(2);
  });

  test("health check returns connected status", async () => {
    const health = await backend.healthCheck();
    expect(health.connected).toBe(true);
    expect(health.backend_type).toBe("sqlite");
  });

  // -------------------------------------------------------------------------
  // SEC-11 (VAL-FREEZE-007): createRelationship validates relationship type
  // against the RelationshipType enum and rejects invalid types with a
  // clear error. Without this check, sqlite silently stored arbitrary
  // strings in `relationships.rel_type`, corrupting the graph and breaking
  // export→import round-trips into Cypher backends.
  // -------------------------------------------------------------------------
  describe("SEC-11: createRelationship validates relationship type (VAL-FREEZE-007)", () => {
    test("rejects an invalid relationship type with a clear error", async () => {
      const problemId = await db.storeMemory(
        createMemory({ type: "problem", title: "P", content: "c" })
      );
      const solutionId = await db.storeMemory(
        createMemory({ type: "solution", title: "S", content: "c" })
      );

      await expect(
        db.createRelationship(solutionId, problemId, "NOT_A_REAL_RELATIONSHIP_TYPE")
      ).rejects.toThrow(/Invalid relationship type/);
    });

    test("error message lists the valid relationship types", async () => {
      const a = await db.storeMemory(createMemory({ type: "problem", title: "A", content: "c" }));
      const b = await db.storeMemory(createMemory({ type: "solution", title: "B", content: "c" }));

      try {
        await db.createRelationship(a, b, "BOGUS");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err instanceof Error).toBe(true);
        const msg = (err as Error).message;
        expect(msg).toContain("BOGUS");
        // Mentions at least one valid type as guidance.
        expect(msg).toContain("SOLVES");
      }
    });

    test("does not write the invalid relationship to the database", async () => {
      const a = await db.storeMemory(createMemory({ type: "problem", title: "A", content: "c" }));
      const b = await db.storeMemory(createMemory({ type: "solution", title: "B", content: "c" }));

      try {
        await db.createRelationship(a, b, "INVALID_TYPE_XYZ");
      } catch {
        // expected
      }

      const stats = await db.getMemoryStatistics();
      const totalRels = stats["total_relationships"] as Record<string, unknown>;
      expect(totalRels["count"]).toBe(0);
    });

    test("accepts a valid relationship type (regression)", async () => {
      const a = await db.storeMemory(createMemory({ type: "problem", title: "A", content: "c" }));
      const b = await db.storeMemory(createMemory({ type: "solution", title: "B", content: "c" }));

      const relId = await db.createRelationship(b, a, "SOLVES");
      expect(relId).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-LOCAL-011: atomic delete transaction. The sqlite backend must wrap
  // the two-statement delete (rels + memory) in a SINGLE transaction so a
  // failure between the two statements cannot leave a memory deleted but
  // its relationships orphaned (or vice versa).
  // -------------------------------------------------------------------------
  describe("VAL-LOCAL-011: atomic delete transaction (single txn)", () => {
    test("a failure between rel-delete and memory-delete rolls back (no orphans)", async () => {
      const a = await db.storeMemory(createMemory({ type: "problem", title: "A", content: "c" }));
      const b = await db.storeMemory(createMemory({ type: "solution", title: "B", content: "c" }));
      await db.createRelationship(b, a, "SOLVES");

      // Sanity: the relationship exists.
      expect((await db.getRelatedMemories(b, { maxDepth: 1 })).length).toBe(1);

      // Monkeypatch the underlying sqlite handle so the memory-delete
      // `prepare` throws, simulating a failure BETWEEN the two DELETE
      // statements. The rel-delete must be rolled back so the relationship
      // is NOT orphaned (deleted while the memory survives).
      const dbObj = backend.db!;
      const origPrepare = dbObj.prepare.bind(dbObj);
      (dbObj as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        if (sql.startsWith("DELETE FROM memories")) {
          throw new Error("synthetic memory-delete failure");
        }
        return origPrepare(sql);
      };

      try {
        await expect(db.deleteMemory(a)).rejects.toThrow(/synthetic memory-delete failure/);
        // The rel-delete must have been rolled back — relationships NOT orphaned.
        const related = await db.getRelatedMemories(b, { maxDepth: 1 });
        expect(related.length).toBe(1);
        // And the memory itself still exists (rollback restored both statements).
        const stillExists = await db.getMemory(a);
        expect(stillExists).not.toBeNull();
      } finally {
        (dbObj as { prepare: (sql: string) => unknown }).prepare = origPrepare;
      }
    });

    test("successful delete still removes both memory and its relationships", async () => {
      const a = await db.storeMemory(createMemory({ type: "problem", title: "A", content: "c" }));
      const b = await db.storeMemory(createMemory({ type: "solution", title: "B", content: "c" }));
      await db.createRelationship(b, a, "SOLVES");

      expect((await db.getRelatedMemories(b, { maxDepth: 1 })).length).toBe(1);

      const ok = await db.deleteMemory(a);
      expect(ok).toBe(true);

      // Memory gone, relationships gone — no orphans either way.
      expect(await db.getMemory(a)).toBeNull();
      expect((await db.getRelatedMemories(b, { maxDepth: 1 })).length).toBe(0);
    });
  });
});

const SEARCH_TEST_DB = join(tmpdir(), `mg-search-test-${Date.now()}.db`);

describe("SQLiteBackend search matching", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;

  const searchQuery = (overrides: Record<string, unknown>) => ({
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
    search_tolerance: "normal" as const,
    match_mode: "any" as const,
    relationship_filter: undefined,
    ...overrides,
  });

  beforeEach(async () => {
    backend = new SQLiteBackend(SEARCH_TEST_DB);
    await backend.connect();
    await backend.initializeSchema();
    db = new MemoryDatabase(backend);
  });

  afterEach(async () => {
    await backend.disconnect();
    try {
      if (existsSync(SEARCH_TEST_DB)) unlinkSync(SEARCH_TEST_DB);
    } catch {
      // ignore
    }
  });

  test("matches a multi-word query whose words are not adjacent", async () => {
    await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Pinch zoom crashes Safari on iOS",
        content: "Reproduced on a physical iPhone after two gesture cycles.",
      })
    );

    const results = await db.searchMemories(searchQuery({ query: "iOS pinch crash" }));
    expect(results.length).toBe(1);
  });

  test("is insensitive to word order", async () => {
    await db.storeMemory(
      createMemory({ type: "error", title: "Setup traps that wasted time", content: "Four traps." })
    );

    const forward = await db.searchMemories(searchQuery({ query: "wasted time" }));
    const reversed = await db.searchMemories(searchQuery({ query: "time wasted" }));
    expect(forward.length).toBe(1);
    expect(reversed.length).toBe(1);
  });

  test("matches terms against tags", async () => {
    await db.storeMemory(
      createMemory({
        type: "workflow",
        title: "Device automation",
        content: "Start the server.",
        tags: ["appium", "android"],
      })
    );

    const results = await db.searchMemories(searchQuery({ query: "appium setup" }));
    expect(results.length).toBe(1);
  });

  test("match_mode 'all' requires every term to match", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "Android pinch zoom", content: "Works via W3C actions." })
    );
    await db.storeMemory(
      createMemory({ type: "solution", title: "Endsheet fade in", content: "Delayed reveal." })
    );

    const any = await db.searchMemories(searchQuery({ query: "android endsheet", match_mode: "any" }));
    expect(any.length).toBe(2);

    const all = await db.searchMemories(searchQuery({ query: "android endsheet", match_mode: "all" }));
    expect(all.length).toBe(0);
  });

  test("honours an explicit terms list", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "Chromedriver autodownload", content: "Namespaced flag." })
    );

    const results = await db.searchMemories(
      searchQuery({ query: "ignored when terms are given", terms: ["chromedriver"] })
    );
    expect(results.length).toBe(1);
  });

  test("applies an explicit terms list when no query is given", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "Chromedriver autodownload", content: "Namespaced flag." })
    );
    await db.storeMemory(
      createMemory({ type: "solution", title: "Unrelated memory", content: "Nothing in common." })
    );

    const results = await db.searchMemories(
      searchQuery({ query: undefined, terms: ["chromedriver"] })
    );
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Chromedriver autodownload");
  });

  test("trims and de-duplicates explicit terms and drops empty ones", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "Chromedriver autodownload", content: "Namespaced flag." })
    );
    await db.storeMemory(
      createMemory({ type: "solution", title: "Unrelated memory", content: "Nothing in common." })
    );

    const results = await db.searchMemories(
      searchQuery({ query: undefined, terms: ["  Chromedriver  ", "chromedriver", "", "   "] })
    );
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Chromedriver autodownload");
  });

  test("caps an oversized explicit terms list without failing", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "Chromedriver autodownload", content: "Namespaced flag." })
    );

    const terms = ["chromedriver", ...Array.from({ length: 300 }, (_, i) => `absent${i}`)];
    const results = await db.searchMemories(searchQuery({ query: undefined, terms }));
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Chromedriver autodownload");
  });

  test("does not score the query phrase when explicit terms take precedence", async () => {
    await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Alpha record",
        content: "Mentions chromedriver only.",
        importance: 0.9,
      })
    );
    await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Beta record",
        content: "Mentions chromedriver and the ignored phrase too.",
        importance: 0.4,
      })
    );

    const results = await db.searchMemories(
      searchQuery({ query: "the ignored phrase", terms: ["chromedriver"] })
    );
    expect(results.length).toBe(2);
    expect(results[0].title).toBe("Alpha record");
  });

  test("treats an underscore in a term as a literal character", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "order_id lookup", content: "Literal underscore." })
    );
    await db.storeMemory(
      createMemory({ type: "solution", title: "orderXid lookup", content: "Wildcard would match this." })
    );

    const results = await db.searchMemories(searchQuery({ query: "order_id" }));
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("order_id lookup");
  });

  test("does not treat a wildcard-only query as a match-all", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "First memory", content: "Content one." })
    );
    await db.storeMemory(
      createMemory({ type: "solution", title: "Second memory", content: "Content two." })
    );

    expect((await db.searchMemories(searchQuery({ query: "%" }))).length).toBe(0);
    expect((await db.searchMemories(searchQuery({ query: "%%" }))).length).toBe(0);
  });

  test("ranks a title match above a more important body-only match", async () => {
    await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Unrelated title",
        content: "Mentions pagination once.",
        importance: 0.9,
      })
    );
    await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Pagination offset fix",
        content: "Unrelated body.",
        importance: 0.4,
      })
    );

    const results = await db.searchMemories(searchQuery({ query: "pagination" }));
    expect(results.length).toBe(2);
    expect(results[0].title).toBe("Pagination offset fix");
  });

  test("keeps punctuation inside identifiers", async () => {
    await db.storeMemory(
      createMemory({ type: "fix", title: "next.config.js rewrite", content: "Proxy the embed route." })
    );
    await db.storeMemory(
      createMemory({ type: "fix", title: "Unrelated", content: "No config reference here." })
    );

    const results = await db.searchMemories(searchQuery({ query: "next.config.js" }));
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("next.config.js rewrite");
  });

  test("falls back to the raw query when only stopwords remain", async () => {
    await db.storeMemory(
      createMemory({ type: "solution", title: "The and of", content: "Literal phrase in title." })
    );

    const hit = await db.searchMemories(searchQuery({ query: "the and of" }));
    expect(hit.length).toBe(1);

    const miss = await db.searchMemories(searchQuery({ query: "of and the" }));
    expect(miss.length).toBe(0);
  });

  test("bulkStoreMemories ingests memories in batch transaction", async () => {
    const batch = [
      createMemory({ type: "solution", title: "Batch Memory 1", content: "Content 1" }),
      createMemory({ type: "solution", title: "Batch Memory 2", content: "Content 2" }),
      createMemory({ type: "solution", title: "Batch Memory 3", content: "Content 3" }),
    ];
    const ids = await db.bulkStoreMemories(batch);
    expect(ids.length).toBe(3);

    const m1 = await db.getMemory(ids[0]);
    expect(m1).not.toBeNull();
    expect(m1?.title).toBe("Batch Memory 1");
  });

  test("FTS5 Porter stemming matches inflected words", async () => {
    await db.storeMemory(
      createMemory({
        type: "solution",
        title: "Ingress proxy rollout guide",
        content: "Detailed instructions for handling connection termination.",
      })
    );

    // "rollouts" (plural) matches "rollout" via Porter stemmer
    const res1 = await db.searchMemories(searchQuery({ query: "rollouts" }));
    expect(res1.length).toBeGreaterThan(0);
    expect(res1[0].title).toBe("Ingress proxy rollout guide");

    // "terminating" matches "termination" via Porter stemmer
    const res2 = await db.searchMemories(searchQuery({ query: "terminating" }));
    expect(res2.length).toBeGreaterThan(0);
    expect(res2[0].title).toBe("Ingress proxy rollout guide");
  });

  test("getRelatedMemories traverses multi-hop graph via recursive CTE", async () => {
    const m1 = await db.storeMemory(createMemory({ type: "problem", title: "Origin Problem", content: "Problem body" }));
    const m2 = await db.storeMemory(createMemory({ type: "solution", title: "Intermediate Solution", content: "Solution body" }));
    const m3 = await db.storeMemory(createMemory({ type: "fix", title: "Deep Fix", content: "Fix body" }));

    await db.createRelationship(m2, m1, "SOLVES");
    await db.createRelationship(m3, m2, "BUILDS_ON");

    // 1-hop traversal
    const hop1 = await db.getRelatedMemories(m1, { maxDepth: 1 });
    expect(hop1.length).toBe(1);
    expect(hop1[0][0].title).toBe("Intermediate Solution");

    // 2-hop recursive traversal
    const hop2 = await db.getRelatedMemories(m1, { maxDepth: 2 });
    expect(hop2.length).toBe(2);
    const titles = hop2.map((h) => h[0].title);
    expect(titles).toContain("Intermediate Solution");
    expect(titles).toContain("Deep Fix");
  });
});
