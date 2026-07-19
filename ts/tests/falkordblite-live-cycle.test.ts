/**
 * LIVE integration test: real store → search → recall cycle on the default
 * falkordblite backend using parameterized Cypher.
 *
 * This is the test that would have caught the H8 param-passing bug
 * (`this.graph.query(query, params)` → `this.graph.query(query, { params })`)
 * and the M13 legacy `CREATE CONSTRAINT` schema-init bug.
 *
 * Uses a temp MEMORY_FALKORDBLITE_PATH so it never touches ~/.memorygraph.
 * Requires `redis-server` on PATH (brew 8.8.0 + FalkorDB v4.16.3 module).
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FalkorDBLiteBackend } from "../src/backends/falkordblite.js";
import { createMemory } from "../src/models.js";
import type { SearchQuery } from "../src/models.js";

const STASH_FALKORDBLITE_PATH = process.env.MEMORY_FALKORDBLITE_PATH;

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), `mg-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
}

async function withBackend<T>(
  fn: (backend: FalkorDBLiteBackend) => Promise<T>
): Promise<T> {
  const dir = freshTempDir();
  process.env.MEMORY_FALKORDBLITE_PATH = join(dir, "falkordblite.db");
  const backend = new FalkorDBLiteBackend();
  try {
    await backend.connect();
    return await fn(backend);
  } finally {
    try {
      await backend.disconnect();
    } catch {
      // best-effort
    }
    delete process.env.MEMORY_FALKORDBLITE_PATH;
    if (STASH_FALKORDBLITE_PATH) process.env.MEMORY_FALKORDBLITE_PATH = STASH_FALKORDBLITE_PATH;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const baseSearch: SearchQuery = {
  query: "",
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
};

describe("VAL-FAILOPEN-002: falkordblite schema init uses GRAPH.CONSTRAINT", () => {
  test("initializeSchema completes without 'Invalid constraint command' error", async () => {
    // Capture stderr to detect the swallowed legacy-constraint error.
    const stderrChunks: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      stderrChunks.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await withBackend(async (backend) => {
        // initializeSchema() is called inside connect() via the factory path,
        // but here we connected directly. Call it explicitly to exercise it.
        await backend.initializeSchema();
      });
    } finally {
      console.error = origErr;
    }

    const stderr = stderrChunks.join("\n");
    // The legacy form would emit "Invalid constraint command use the GRAPH.CONSTRAINT command instead"
    expect(stderr).not.toContain("Invalid constraint command");
    expect(stderr).not.toContain("GRAPH.CONSTRAINT command instead");
  });
});

describe("VAL-FAILOPEN-001: live falkordblite store → search → recall cycle", () => {
  test("store → search → recall succeeds with parameterized Cypher (no 'Missing parameters')", async () => {
    await withBackend(async (backend) => {
      // Capture stderr to detect the H8 "Missing parameters" symptom.
      const stderrChunks: string[] = [];
      const origErr = console.error;
      console.error = (...args: unknown[]) => {
        stderrChunks.push(args.map((a) => String(a)).join(" "));
      };

      let storedId: string;
      try {
        // store
        const mem = createMemory({
          type: "solution",
          title: "Failopen probe title",
          content: "failopen probe content with the magic word zzz-unique-token",
          tags: ["probe", "failopen"],
          importance: 0.8,
        });
        storedId = await backend.storeMemory(mem);
        expect(storedId).toBeDefined();
        expect(typeof storedId).toBe("string");
        expect(storedId.length).toBeGreaterThan(0);

        // search by content
        const hits = await backend.searchMemories({
          ...baseSearch,
          query: "zzz-unique-token",
        });
        expect(hits.length).toBeGreaterThanOrEqual(1);
        const found = hits.find((m) => m.id === storedId);
        expect(found).toBeDefined();
        expect(found!.content).toContain("zzz-unique-token");

        // search by tag (parameterized list param)
        const tagHits = await backend.searchMemories({
          ...baseSearch,
          query: undefined,
          tags: ["failopen"],
        });
        expect(tagHits.length).toBeGreaterThanOrEqual(1);
        expect(tagHits.some((m) => m.id === storedId)).toBe(true);

        // get by id (parameterized)
        const got = await backend.getMemory(storedId, false);
        expect(got).not.toBeNull();
        expect(got!.title).toBe("Failopen probe title");

        // update (parameterized SET)
        got!.content = "updated content with a different token: aaa-updated-marker";
        const ok = await backend.updateMemory(got!);
        expect(ok).toBe(true);

        // recall-shaped search (recall falls back to search at this stage;
        // the point is that parameterized search works)
        const recallHits = await backend.searchMemories({
          ...baseSearch,
          query: "aaa-updated-marker",
          limit: 20,
        });
        expect(recallHits.some((m) => m.id === storedId)).toBe(true);

        // delete (parameterized)
        const delOk = await backend.deleteMemory(storedId);
        expect(delOk).toBe(true);
      } finally {
        console.error = origErr;
      }

      const stderr = stderrChunks.join("\n");
      // H8 symptom: "Missing parameters" or "expected STARTS WITH, SET or START"
      expect(stderr).not.toContain("Missing parameters");
      expect(stderr).not.toContain("expected STARTS WITH");
      expect(stderr).not.toContain("Query execution failed");
    });
  });
});
