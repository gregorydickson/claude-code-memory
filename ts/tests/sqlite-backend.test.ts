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
});
