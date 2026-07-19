/**
 * M5 feature parity on the DEFAULT falkordblite backend (Tier 1 #10).
 *
 * Covers:
 *   - VAL-LOCAL-017 / 018 / 019: H7 temporal (as-of / history / changes) on
 *     falkordblite with minimal memory versioning.
 *   - VAL-LOCAL-020..030: M7 intelligence / analytics / proactive sweep on
 *     falkordblite — every command exits 0 with structured output.
 *   - VAL-LOCAL-031: M1 recall != search — handleRecallMemories calls
 *     backend.recallMemories (with fallback), and recall produces results
 *     that differ from search.
 *   - VAL-CROSS-001: full create → search → recall → related → link → stats
 *     cycle on falkordblite.
 *   - VAL-CROSS-006: falkordblite full feature sweep (every Cypher-requiring
 *     feature produces structured output without throwing).
 *
 * Uses a temp MEMORY_FALKORDBLITE_PATH so it never touches ~/.memorygraph.
 * Requires `redis-server` on PATH (brew 8.8.0 + FalkorDB v4.16.3 module) —
 * which the M5 vendoring step makes available offline.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FalkorDBLiteBackend } from "../src/backends/falkordblite.js";
import { MemoryDatabase } from "../src/database.js";
import { createMemory, createRelationshipProperties } from "../src/models.js";
import {
  handleQueryAsOf,
  handleGetRelationshipHistory,
  handleWhatChanged,
} from "../src/tools/temporal.js";
import { handleRecallMemories, handleSearchMemories } from "../src/tools/search.js";
import {
  extractEntities,
  linkEntities,
} from "../src/intelligence/entity-extraction.js";
import {
  findSimilarProblems,
  suggestPatterns,
} from "../src/intelligence/pattern-recognition.js";
import { getContext } from "../src/intelligence/context-retrieval.js";
import {
  getMemoryGraphVisualization,
  analyzeSolutionSimilarity,
  recommendLearningPaths,
  identifyKnowledgeGaps,
} from "../src/analytics/advanced-queries.js";
import {
  generateSessionBriefing,
  formatBriefingAsText,
} from "../src/proactive/session-briefing.js";
import { predictNeeds, warnPotentialIssues } from "../src/proactive/predictive.js";
import { recordOutcome } from "../src/proactive/outcome-learning.js";

const STASH_PATH = process.env.MEMORY_FALKORDBLITE_PATH;

function freshTempDir(): string {
  return mkdtempSync(
    join(tmpdir(), `mg-parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`)
  );
}

async function withDb<T>(
  fn: (db: MemoryDatabase, backend: FalkorDBLiteBackend, dir: string) => Promise<T>
): Promise<T> {
  const dir = freshTempDir();
  process.env.MEMORY_FALKORDBLITE_PATH = join(dir, "falkordblite.db");
  const backend = new FalkorDBLiteBackend();
  await backend.connect();
  await backend.initializeSchema();
  const db = new MemoryDatabase(backend);
  try {
    return await fn(db, backend, dir);
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

// ---------------------------------------------------------------------------
// M1: recall != search (VAL-LOCAL-031)
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-031: M1 recall != search on falkordblite", () => {
  test("handleRecallMemories calls backend.recallMemories (with fallback), not just searchMemories", async () => {
    await withDb(async (db, backend) => {
      // Store two memories with the same query token but different
      // usage_count / effectiveness so the recall ranking (which weighs
      // usage_count + effectiveness) differs from the search ranking
      // (which orders by importance DESC, created_at DESC).
      const lowUsage = createMemory({
        type: "solution",
        title: "Recall probe alpha",
        content: "recall-target-token alpha variant",
        tags: ["recall"],
        importance: 0.9, // high importance → search ranks this first
        confidence: 0.8,
        usage_count: 0, // low usage → recall ranks this last
        effectiveness: 0.1,
      });
      const highUsage = createMemory({
        type: "solution",
        title: "Recall probe beta",
        content: "recall-target-token beta variant",
        tags: ["recall"],
        importance: 0.5, // lower importance → search ranks this second
        confidence: 0.8,
        usage_count: 50, // high usage → recall ranks this first
        effectiveness: 0.95,
      });

      const idLow = await db.storeMemory(lowUsage);
      const idHigh = await db.storeMemory(highUsage);

      // backend.recallMemories must be implemented on falkordblite.
      expect(typeof (backend as any).recallMemories).toBe("function");

      // db.recallMemories delegates to backend.recallMemories.
      expect(typeof (db as any).recallMemories).toBe("function");

      const recalled = await (db as any).recallMemories("recall-target-token", { limit: 10 });
      expect(Array.isArray(recalled)).toBe(true);
      expect(recalled.length).toBeGreaterThanOrEqual(2);

      // Recall ranks by recall_score (usage_count + effectiveness weighted),
      // so the high-usage memory comes first.
      expect(recalled[0].id).toBe(idHigh);
      expect(recalled[1].id).toBe(idLow);

      // Search ranks by importance DESC, so the high-importance memory first.
      const searched = await db.searchMemories({
        query: "recall-target-token",
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
        limit: 10,
        offset: 0,
        include_relationships: true,
        search_tolerance: "normal",
        match_mode: "any",
        relationship_filter: undefined,
      });
      expect(searched[0].id).toBe(idLow);
      expect(searched[1].id).toBe(idHigh);

      // The orderings differ → recall != search.
      expect(recalled[0].id).not.toBe(searched[0].id);
    });
  });

  test("handleRecallMemories returns recall-shaped output (not identical to search)", async () => {
    await withDb(async (db) => {
      const mem = createMemory({
        type: "solution",
        title: "Recall shape probe",
        content: "recall-shape-token content body",
        tags: ["shape"],
        importance: 0.7,
      });
      await db.storeMemory(mem);

      const recallResult = await handleRecallMemories(db, { query: "recall-shape-token" });
      expect(recallResult.isError).toBe(false);
      // Recall output has the "Found N relevant memories" header and a
      // "Next steps" footer that search output does not.
      expect(recallResult.text).toContain("relevant memories");
      expect(recallResult.text).toContain("Next steps");

      const searchResult = await handleSearchMemories(db, { query: "recall-shape-token" });
      expect(searchResult.isError).toBe(false);
      // Search output uses the "Found N memories:" header.
      expect(searchResult.text).toContain("Found");
      // Search output does NOT include the "Next steps" footer.
      expect(searchResult.text).not.toContain("Next steps");
    });
  });
});

// ---------------------------------------------------------------------------
// H7: temporal versioning on falkordblite (VAL-LOCAL-017 / 018 / 019)
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-017..019: H7 temporal on falkordblite", () => {
  test("updateMemory snapshots prior state; getMemoryStateAt returns pre-update state", async () => {
    await withDb(async (db, backend) => {
      const mem = createMemory({
        type: "solution",
        title: "Versioned probe v1",
        content: "original-content-token-v1",
        tags: ["versioned"],
        importance: 0.7,
      });
      const id = await db.storeMemory(mem);

      // Capture the timestamp BEFORE the update. The pre-update state is
      // valid up to the update timestamp; using a timestamp strictly before
      // the update (but after creation) guarantees getMemoryStateAt returns
      // the pre-update snapshot.
      const beforeUpdate = new Date();
      // Yield a beat so the update timestamp is strictly after beforeUpdate.
      await new Promise((r) => setTimeout(r, 50));

      // Update the memory with new content.
      const got = await db.getMemory(id, false);
      expect(got).not.toBeNull();
      got!.content = "updated-content-token-v2";
      got!.title = "Versioned probe v2";
      const ok = await db.updateMemory(got!);
      expect(ok).toBe(true);

      // The current memory reflects the update.
      const current = await db.getMemory(id, false);
      expect(current!.content).toBe("updated-content-token-v2");

      // getMemoryStateAt MUST be implemented on falkordblite.
      expect(typeof (backend as any).getMemoryStateAt).toBe("function");
      expect(typeof (db as any).getMemoryStateAt).toBe("function");

      // The state at `beforeUpdate` is the pre-update snapshot.
      const historical = await (db as any).getMemoryStateAt(id, beforeUpdate);
      expect(historical).not.toBeNull();
      expect(historical.content).toBe("original-content-token-v1");
      expect(historical.title).toBe("Versioned probe v1");
    });
  });

  test("getMemoryVersions returns non-empty version history", async () => {
    await withDb(async (db, backend) => {
      const mem = createMemory({
        type: "solution",
        title: "History probe v1",
        content: "history-original-v1",
        tags: ["history"],
      });
      const id = await db.storeMemory(mem);

      // No updates yet → versions list contains just the current state.
      let versions = await (db as any).getMemoryVersions(id);
      expect(Array.isArray(versions)).toBe(true);
      expect(versions.length).toBeGreaterThanOrEqual(1);

      // Update → a historical version is snapshotted.
      const got = await db.getMemory(id, false);
      got!.content = "history-updated-v2";
      await db.updateMemory(got!);

      versions = await (db as any).getMemoryVersions(id);
      expect(versions.length).toBeGreaterThanOrEqual(2);
      // At least one historical (pre-update) version with the original content.
      const historical = versions.find(
        (v: any) => v.content === "history-original-v1"
      );
      expect(historical).toBeDefined();
      // At least one current version with the updated content.
      const current = versions.find(
        (v: any) => v.content === "history-updated-v2"
      );
      expect(current).toBeDefined();
    });
  });

  test("handleQueryAsOf surfaces the memory's state at the timestamp (VAL-LOCAL-017)", async () => {
    await withDb(async (db) => {
      const mem = createMemory({
        type: "solution",
        title: "AsOf probe v1",
        content: "asof-original-v1",
        tags: ["asof"],
      });
      const id = await db.storeMemory(mem);

      const beforeUpdate = new Date();
      await new Promise((r) => setTimeout(r, 50));

      const got = await db.getMemory(id, false);
      got!.content = "asof-updated-v2";
      await db.updateMemory(got!);

      const result = await handleQueryAsOf(db, {
        memory_id: id,
        as_of: beforeUpdate.toISOString(),
      });

      expect(result.isError).toBe(false);
      // The as-of output surfaces the pre-update state.
      expect(result.text).toContain("asof-original-v1");
      expect(result.text).toContain("AsOf probe v1");
    });
  });

  test("handleGetRelationshipHistory includes memory version history (VAL-LOCAL-018)", async () => {
    await withDb(async (db) => {
      const mem = createMemory({
        type: "solution",
        title: "HistoryCmd probe v1",
        content: "historycmd-original-v1",
        tags: ["historycmd"],
      });
      const id = await db.storeMemory(mem);

      const got = await db.getMemory(id, false);
      got!.content = "historycmd-updated-v2";
      await db.updateMemory(got!);

      const result = await handleGetRelationshipHistory(db, { memory_id: id });
      expect(result.isError).toBe(false);
      // The history output includes a version history section.
      expect(result.text).toContain("Version History");
      // Both the original and the updated content appear in the version history.
      expect(result.text).toContain("historycmd-original-v1");
      expect(result.text).toContain("historycmd-updated-v2");
    });
  });

  test("handleWhatChanged returns structured changes since a timestamp (VAL-LOCAL-019)", async () => {
    await withDb(async (db) => {
      const problemId = await db.storeMemory(
        createMemory({
          type: "problem",
          title: "Changes problem",
          content: "A problem for changes probe",
          tags: ["changes"],
        })
      );
      const solutionId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "Changes solution",
          content: "A solution for changes probe",
          tags: ["changes"],
        })
      );

      const before = new Date(Date.now() - 1000).toISOString();
      await db.createRelationship(solutionId, problemId, "SOLVES");

      const result = await handleWhatChanged(db, { since: before });
      expect(result.isError).toBe(false);
      // Structured output: either a "Changes since" header with new
      // relationships, or a "No relationship changes found" message.
      expect(
        result.text.includes("Changes since") ||
          result.text.includes("New Relationships")
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// M7: intelligence / analytics / proactive sweep on falkordblite
// (VAL-LOCAL-020..030, VAL-CROSS-006)
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-020..030 / VAL-CROSS-006: M7 feature sweep on falkordblite", () => {
  // Shared populated store for the sweep. Each test gets a fresh store via
  // withDb, populates it, then runs the command under test.

  async function populate(db: MemoryDatabase, backend: FalkorDBLiteBackend): Promise<{
    problemId: string;
    solutionId: string;
  }> {
    const problemId = await db.storeMemory(
      createMemory({
        type: "problem",
        title: "React auth timeout",
        content: "React JWT auth component times out on token refresh in production",
        tags: ["react", "auth", "jwt", "bug"],
        importance: 0.9,
      })
    );
    const solutionId = await db.storeMemory(
      createMemory({
        type: "solution",
        title: "JWT refresh retry with backoff",
        content: "Implement retry logic with exponential backoff for JWT auth refresh in React components using context",
        tags: ["react", "auth", "jwt", "solution"],
        importance: 0.8,
        usage_count: 5,
        effectiveness: 0.85,
      })
    );
    await db.createRelationship(
      solutionId,
      problemId,
      "SOLVES",
      createRelationshipProperties({ strength: 0.9, confidence: 0.85 })
    );
    // Link entities for the solution memory so `entities --link` has work to do.
    const text = "React JWT auth context";
    const entities = extractEntities(text);
    if (entities.length > 0) {
      try {
        await linkEntities(backend, solutionId, entities);
      } catch {
        // best-effort — entity linking is not the focus of this test
      }
    }
    return { problemId, solutionId };
  }

  test("entities (VAL-LOCAL-020) — exits 0, returns extracted entities", async () => {
    await withDb(async (db, _backend) => {
      const { solutionId } = await populate(db, _backend);
      const mem = await db.getMemory(solutionId, false);
      const entities = extractEntities(`${mem!.title} ${mem!.content}`);
      expect(entities.length).toBeGreaterThan(0);
    });
  });

  test("patterns (VAL-LOCAL-021) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      await populate(db, backend);
      const similar = await findSimilarProblems(backend, "auth timeout");
      const suggestions = await suggestPatterns(backend, "auth timeout");
      // Both calls return arrays (possibly empty) without throwing.
      expect(Array.isArray(similar)).toBe(true);
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  test("context (VAL-LOCAL-022) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      await populate(db, backend);
      const result = await getContext(backend, "auth", 4000, null);
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    });
  });

  test("visualize (VAL-LOCAL-023) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      await populate(db, backend);
      const viz = await getMemoryGraphVisualization(backend, null, 2, 100);
      expect(viz).toBeDefined();
      expect(viz.nodes).toBeDefined();
      expect(viz.edges).toBeDefined();
      expect(Array.isArray(viz.nodes)).toBe(true);
      expect(Array.isArray(viz.edges)).toBe(true);
    });
  });

  test("similarity (VAL-LOCAL-024) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      const { solutionId } = await populate(db, backend);
      const similar = await analyzeSolutionSimilarity(backend, solutionId, 5, 0.0);
      expect(Array.isArray(similar)).toBe(true);
    });
  });

  test("learning (VAL-LOCAL-025) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      await populate(db, backend);
      const paths = await recommendLearningPaths(backend, "react-auth", 3);
      expect(Array.isArray(paths)).toBe(true);
    });
  });

  test("gaps (VAL-LOCAL-026) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      await populate(db, backend);
      const gaps = await identifyKnowledgeGaps(backend, null);
      expect(Array.isArray(gaps)).toBe(true);
    });
  });

  test("briefing (VAL-LOCAL-027) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      await populate(db, backend);
      const briefing = await generateSessionBriefing(backend, process.cwd());
      // Briefing may be null if no project detected; that's a valid
      // structured "no briefing" outcome. The CLI command handles both.
      if (briefing) {
        const text = formatBriefingAsText(briefing, "standard");
        expect(typeof text).toBe("string");
      }
    });
  });

  test("predict (VAL-LOCAL-028) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      await populate(db, backend);
      const suggestions = await predictNeeds(backend, "auth");
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  test("warn (VAL-LOCAL-029) — does not throw, returns structured result", async () => {
    await withDb(async (db, backend) => {
      await populate(db, backend);
      const warnings = await warnPotentialIssues(backend, "auth");
      expect(Array.isArray(warnings)).toBe(true);
    });
  });

  test("outcome (VAL-LOCAL-030) — does not throw, records the outcome", async () => {
    await withDb(async (db, backend) => {
      const { solutionId } = await populate(db, backend);
      const ok = await recordOutcome(backend, solutionId, "worked in production", true);
      expect(ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-001: full create → search → recall → related → link → stats cycle
// ---------------------------------------------------------------------------

describe("VAL-CROSS-001: full cycle on falkordblite", () => {
  test("create → search → recall → related → link → stats all succeed", async () => {
    await withDb(async (db) => {
      const a = await db.storeMemory(
        createMemory({
          type: "problem",
          title: "Cycle problem A",
          content: "cycle-probe-token problem A",
          tags: ["cycle"],
        })
      );
      const b = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "Cycle solution B",
          content: "cycle-probe-token solution B",
          tags: ["cycle"],
          usage_count: 3,
          effectiveness: 0.8,
        })
      );

      // search
      const searchHits = await db.searchMemories({
        query: "cycle-probe-token",
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
      expect(searchHits.length).toBeGreaterThanOrEqual(2);

      // recall (via the tool handler, which calls db.recallMemories)
      const recallResult = await handleRecallMemories(db, { query: "cycle-probe-token" });
      expect(recallResult.isError).toBe(false);

      // link
      const relId = await db.createRelationship(b, a, "SOLVES");
      expect(relId).toBeDefined();

      // related
      const related = await db.getRelatedMemories(b, { maxDepth: 2 });
      expect(related.length).toBeGreaterThanOrEqual(1);
      const hasA = related.some(([m]) => m.id === a);
      expect(hasA).toBe(true);

      // stats
      const stats = await db.getMemoryStatistics();
      expect(stats).toBeDefined();
      expect((stats["total_memories"] as Record<string, unknown>)?.["count"] ?? stats["total_memories"]).toBeTruthy();
    });
  });
});
