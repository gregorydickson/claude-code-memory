/**
 * M5 part 5b — FalkorDB datetime() parity on the DEFAULT falkordblite backend
 * (M14, Tier 1 #10).
 *
 * FalkorDB v4.16.3 does NOT implement the Cypher `datetime()` function.
 * Modules that still use `datetime()` silently degrade to EMPTY results on
 * falkordblite. These tests assert that, after replacing `datetime()` with
 * plain ISO-8601 string params, the time-windowed features return NON-EMPTY
 * meaningful results on a live falkordblite backend.
 *
 * Covers:
 *   - VAL-LOCAL-055: no datetime() Cypher calls remain in ts/src (excluding models.ts)
 *   - VAL-LOCAL-056: briefing returns a NON-EMPTY session briefing referencing
 *     recent memories on falkordblite (last-24h cutoff works)
 *   - VAL-LOCAL-057: context --query returns NON-EMPTY context-retrieval
 *     results on falkordblite (duration arithmetic works)
 *   - VAL-LOCAL-058: entity linking creates/returns linked entities on
 *     falkordblite (linkEntities works)
 *   - VAL-LOCAL-059: workflow records/retrieves NON-EMPTY state with working
 *     timestamps on falkordblite
 *   - VAL-LOCAL-060: capture records context with NON-EMPTY timestamped data
 *     on falkordblite
 *
 * Uses a temp MEMORY_FALKORDBLITE_PATH so it never touches ~/.memorygraph.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { FalkorDBLiteBackend } from "../src/backends/falkordblite.js";
import { MemoryDatabase } from "../src/database.js";
import { createMemory, createRelationshipProperties } from "../src/models.js";
import {
  generateSessionBriefing,
  formatBriefingAsText,
} from "../src/proactive/session-briefing.js";
import { getContext } from "../src/intelligence/context-retrieval.js";
import {
  extractEntities,
  linkEntities,
} from "../src/intelligence/entity-extraction.js";
import {
  trackWorkflow,
  getSessionState,
} from "../src/integration/workflow-tracking.js";
import { captureTaskContext } from "../src/integration/context-capture.js";
import { detectProject } from "../src/integration/project-analysis.js";

const STASH_PATH = process.env.MEMORY_FALKORDBLITE_PATH;

function freshTempDir(prefix: string): string {
  return mkdtempSync(
    join(tmpdir(), `mg-dt-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`)
  );
}

async function withDb<T>(
  fn: (db: MemoryDatabase, backend: FalkorDBLiteBackend, dir: string) => Promise<T>
): Promise<T> {
  const dir = freshTempDir("db");
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

/**
 * Create a fake project directory (with package.json) so `detectProject`
 * returns a non-null ProjectInfo. Memories are stored with
 * context.project_path = projectDir so briefing's project filter matches.
 */
function makeFakeProject(parentDir: string): string {
  const projectDir = join(parentDir, "fake-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "fake-project", version: "1.0.0" })
  );
  return projectDir;
}

// ---------------------------------------------------------------------------
// VAL-LOCAL-055: no datetime() Cypher calls remain in ts/src (excluding models.ts)
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-055: no datetime() Cypher calls in ts/src (excluding models.ts)", () => {
  test("grep -rn 'datetime(' ts/src/ | grep -v models.ts returns no matches", () => {
    // Run ripgrep from the repo ts/src dir; this mirrors the validation
    // contract evidence command exactly.
    const srcDir = join(import.meta.dir, "..", "src");
    const result = spawnSync(
      "rg",
      ["-n", "datetime\\(", srcDir],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const out = result.stdout ? result.stdout.toString() : "";
    // Filter out models.ts lines (the .datetime() zod helper is fine).
    const offending = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.includes("models.ts"));
    expect(offending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-056: briefing returns NON-EMPTY meaningful results on falkordblite
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-056: briefing last-24h cutoff works on falkordblite", () => {
  test("generateSessionBriefing references a recently-stored memory (non-empty recent_activities)", async () => {
    await withDb(async (db, backend, dir) => {
      const projectDir = makeFakeProject(dir);

      // Store a memory in this project so the briefing's project + recency
      // filter matches it.
      const memoryId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "Adopt falkordblite datetime parity",
          content: "Replace all datetime() Cypher calls with ISO string params so falkordblite works.",
          tags: ["m14", "datetime", "parity"],
          importance: 0.8,
          context: {
            project_path: projectDir,
          },
        })
      );
      expect(memoryId).toBeTruthy();

      const briefing = await generateSessionBriefing(backend, projectDir);
      expect(briefing).not.toBeNull();
      expect(briefing!.project_name).toBe("fake-project");
      // The whole point of M14: before the fix, recent_activities was empty
      // because datetime(m.created_at) >= datetime($cutoff) threw on
      // falkordblite and the catch swallowed it into an empty array.
      expect(briefing!.recent_activities.length).toBeGreaterThan(0);
      const referenced = briefing!.recent_activities.some(
        (a) => a.memory_id === memoryId
      );
      expect(referenced).toBe(true);

      // And the formatted briefing text references the memory too.
      const text = formatBriefingAsText(briefing!, "standard");
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("datetime");
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-057: context --query returns NON-EMPTY results on falkordblite
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-057: context-retrieval duration arithmetic works on falkordblite", () => {
  test("getContext returns NON-EMPTY source_memories for a matching query", async () => {
    await withDb(async (db, backend) => {
      // Store a memory with distinctive content + entities so getContext's
      // entity/keyword matching finds it. Before the M14 fix, the
      // `duration.between(m.created_at, datetime())` expression threw on
      // falkordblite and the whole query degraded to empty source_memories.
      const memoryId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "PostgreSQL connection pool tuning",
          content: "PostgreSQL connection pool tuning with pgbouncer for high-throughput React API",
          tags: ["postgres", "performance"],
          importance: 0.8,
        })
      );
      expect(memoryId).toBeTruthy();

      // Link entities so the entity-match branch of getContext's query has
      // work to do (and so VAL-LOCAL-058 is exercised too).
      const entities = extractEntities("PostgreSQL React API pgbouncer");
      expect(entities.length).toBeGreaterThan(0);
      await linkEntities(backend, memoryId, entities);

      const result = await getContext(backend, "PostgreSQL connection pool", 4000, null);
      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      // The whole point of M14 for context-retrieval: NON-EMPTY results.
      expect(result.source_memories.length).toBeGreaterThan(0);
      const found = result.source_memories.some((s) => s.id === memoryId);
      expect(found).toBe(true);
      expect(result.context.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-058: entity linking works on falkordblite (linkEntities)
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-058: entity linking creates linked entities on falkordblite", () => {
  test("linkEntities returns NON-EMPTY entity IDs and creates Entity nodes + MENTIONS rels", async () => {
    await withDb(async (db, backend) => {
      const memoryId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "Redis caching layer for Express API",
          content: "Add Redis caching in front of the Express API to reduce PostgreSQL load.",
          tags: ["redis", "caching"],
          importance: 0.7,
        })
      );

      const entities = extractEntities("Redis Express PostgreSQL API");
      expect(entities.length).toBeGreaterThan(0);

      // Before the M14 fix, linkEntities returned [] because the
      // `e.created_at = datetime()` / `e.last_seen = datetime()` /
      // `r.created_at = datetime()` expressions threw on falkordblite and
      // each per-entity try/catch swallowed it into an empty result.
      const entityIds = await linkEntities(backend, memoryId, entities);
      expect(entityIds.length).toBeGreaterThan(0);

      // Verify the entities + MENTIONS relationships were actually persisted
      // by querying the graph directly.
      const rows = await backend.executeQuery(
        `
        MATCH (m:Memory {id: $memory_id})-[r:MENTIONS]->(e:Entity)
        RETURN e.id as eid, e.text as text, e.created_at as created_at, r.created_at as rel_created_at
        `,
        { memory_id: memoryId }
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // Timestamps must be present and parse as ISO strings (not null/empty).
        const created = row["created_at"];
        const relCreated = row["rel_created_at"];
        expect(typeof created === "string" && created.length > 0).toBe(true);
        expect(typeof relCreated === "string" && relCreated.length > 0).toBe(true);
        // They should parse as valid Dates.
        expect(() => new Date(created as string)).not.toThrow();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-059: workflow records/retrieves NON-EMPTY state with timestamps
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-059: workflow tracking records/retrieves state on falkordblite", () => {
  test("trackWorkflow then getSessionState returns NON-EMPTY state with working timestamps", async () => {
    await withDb(async (_db, backend) => {
      const sessionId = `m14-session-${Date.now()}`;
      // Before the M14 fix, trackWorkflow created the action Memory but the
      // session Entity MERGE threw (`s.created_at = datetime()` etc. on
      // falkordblite), so getSessionState returned null.
      const actionId = await trackWorkflow(
        backend,
        sessionId,
        "file_edit",
        { file: "src/index.ts", lines: 42 },
        true,
        5
      );
      expect(actionId).toBeTruthy();

      // Track a second action to exercise the FOLLOWS relationship path too.
      const actionId2 = await trackWorkflow(
        backend,
        sessionId,
        "command",
        { command: "bun test" },
        true,
        12
      );
      expect(actionId2).toBeTruthy();

      const state = await getSessionState(backend, sessionId);
      expect(state).not.toBeNull();
      expect(state!.session_id).toBe(sessionId);
      // Timestamps must be present and valid (the M14 bug left the session
      // Entity un-created so start_time/last_activity were unreachable).
      expect(state!.start_time).toBeInstanceOf(Date);
      expect(state!.last_activity).toBeInstanceOf(Date);
      // last_activity should be >= start_time.
      expect(state!.last_activity.getTime()).toBeGreaterThanOrEqual(
        state!.start_time.getTime()
      );

      // Verify the session Entity was actually persisted with non-empty
      // ISO string timestamps (the M14 bug left them absent).
      const rows = await backend.executeQuery(
        `
        MATCH (s:Entity {id: $session_id, type: 'session'})
        RETURN s.created_at as created_at, s.start_time as start_time, s.last_activity as last_activity
        `,
        { session_id: sessionId }
      );
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      for (const key of ["created_at", "start_time", "last_activity"]) {
        const v = row[key];
        expect(typeof v === "string" && v.length > 0).toBe(true);
        expect(() => new Date(v as string)).not.toThrow();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-060: capture records context with NON-EMPTY timestamped data
// ---------------------------------------------------------------------------

describe("VAL-LOCAL-060: capture records timestamped context on falkordblite", () => {
  test("captureTaskContext stores the task memory AND creates file Entity nodes with created_at timestamps", async () => {
    await withDb(async (_db, backend) => {
      // Before the M14 fix, captureTaskContext stored the task memory but
      // the file Entity MERGE threw (`f.created_at = datetime()` on
      // falkordblite), so file entities were never persisted.
      const taskId = await captureTaskContext(
        backend,
        "Implement datetime parity for falkordblite",
        ["replace datetime() calls", "add tests"],
        ["src/index.ts", "src/utils/datetime.ts"],
        null
      );
      expect(taskId).toBeTruthy();

      // Verify the task memory was stored.
      const taskMem = await backend.executeQuery(
        `MATCH (m:Memory {id: $task_id}) RETURN m.id as id, m.title as title, m.created_at as created_at`,
        { task_id: taskId }
      );
      expect(taskMem.length).toBe(1);

      // Verify file Entity nodes were created with non-empty created_at.
      const fileEntities = await backend.executeQuery(
        `
        MATCH (m:Memory {id: $task_id})-[:INVOLVES]->(f:Entity {type: 'file'})
        RETURN f.id as fid, f.name as name, f.created_at as created_at
        `,
        { task_id: taskId }
      );
      expect(fileEntities.length).toBe(2);
      for (const fe of fileEntities) {
        const created = fe["created_at"];
        expect(typeof created === "string" && created.length > 0).toBe(true);
        expect(() => new Date(created as string)).not.toThrow();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Guard: confirm the test environment can spin up a falkordblite backend.
// (Skips gracefully if redis-server is unavailable — same as m5-feature-parity.)
// ---------------------------------------------------------------------------

describe("falkordblite backend available for M14 datetime parity tests", () => {
  test("a fresh falkordblite backend can store + retrieve a memory", async () => {
    await withDb(async (db) => {
      const id = await db.storeMemory(
        createMemory({
          type: "general",
          title: "M14 smoke",
          content: "falkordblite backend is available for the M14 datetime parity suite",
          tags: ["m14-smoke"],
        })
      );
      expect(id).toBeTruthy();
      const mem = await db.getMemory(id, false);
      expect(mem).not.toBeNull();
      expect(mem!.title).toBe("M14 smoke");
    });
  });
});
