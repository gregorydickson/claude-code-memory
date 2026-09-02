/**
 * REGRESSION: schema initialization must be idempotent and silent on
 * repeated runs.
 *
 * After the 0.14.0 merge (which brought in a new falkordb.so and diverged
 * from the fix-falkordblight branch), opening an existing database re-issued
 * `CREATE INDEX` DDL on every process start. The duplicate creation raised
 * "Attribute 'id' is already indexed" and the query layer logged it as
 * `Query execution failed: ...` on stderr — even though the schema layer
 * treated it as benign. This polluted the output of every command (stats,
 * briefing, etc.).
 *
 * This test pins the two requirements:
 *  1. Calling `initializeSchema()` more than once on the SAME backend
 *     instance (the factory + createDb double-init) is a no-op after the
 *     first successful run — no DDL is re-issued, so nothing is logged.
 *  2. Opening an ALREADY-EXISTING database (a fresh process against a
 *     populated store) skips DDL entirely and emits no "already indexed" /
 *     "Query execution failed" noise.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FalkorDBLiteBackend } from "../src/backends/falkordblite.js";

const STASH_FALKORDBLITE_PATH = process.env.MEMORY_FALKORDBLITE_PATH;
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), `mg-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
}

/** Capture console.error/stdout while running fn, return what was emitted. */
async function capture<T>(
  fn: () => Promise<T>
): Promise<{ result: T; stderr: string; stdout: string }> {
  const errChunks: string[] = [];
  const outChunks: string[] = [];
  const origErr = console.error;
  const origOut = console.log;
  console.error = (...args: unknown[]) => {
    errChunks.push(args.map((a) => String(a)).join(" "));
  };
  console.log = (...args: unknown[]) => {
    outChunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return { result, stderr: errChunks.join("\n"), stdout: outChunks.join("\n") };
  } finally {
    console.error = origErr;
    console.log = origOut;
  }
}

async function withBackend<T>(
  fn: (backend: FalkorDBLiteBackend, dir: string) => Promise<T>
): Promise<T> {
  const dir = freshTempDir();
  process.env.MEMORY_FALKORDBLITE_PATH = join(dir, "falkordblite.db");
  const backend = new FalkorDBLiteBackend();
  try {
    await backend.connect();
    return await fn(backend, dir);
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

const NOISE_PATTERNS = [/Query execution failed/i, /already indexed/i, /already exists/i, /Constraint already exists/i];

describe("falkordblite schema init is idempotent and silent on repeated runs", () => {
  test("calling initializeSchema() twice on one backend is a silent no-op", async () => {
    await withBackend(async (backend) => {
      const first = await capture(() => backend.initializeSchema());
      // First run creates the schema; it may legitimately log init progress.
      expect(first.result).toBeUndefined();

      const second = await capture(() => backend.initializeSchema());
      expect(second.result).toBeUndefined();

      // The second (guarded) invocation must not re-issue DDL, so it must
      // not emit any index/constraint error noise.
      for (const pattern of NOISE_PATTERNS) {
        expect(second.stderr).not.toMatch(pattern);
      }
      // With the introspection guard in place, a repeat call inside the same
      // connection should not even log "Initializing ... schema..." again.
      expect(second.stdout).not.toContain("Initializing");
    });
  });

  test("opening an already-existing store skips DDL and emits no noise", async () => {
    // First: create and initialize a store, then close it (simulating a prior run).
    const dir = freshTempDir();
    process.env.MEMORY_FALKORDBLITE_PATH = join(dir, "falkordblite.db");
    const firstBackend = new FalkorDBLiteBackend();
    try {
      await firstBackend.connect();
      await firstBackend.initializeSchema();
    } finally {
      try {
        await firstBackend.disconnect();
      } catch {
        // best-effort
      }
    }

    // Second: reopen the SAME database file (a fresh backend, like a new
    // process against a populated store). Schema must already exist.
    const secondBackend = new FalkorDBLiteBackend();
    try {
      await secondBackend.connect();
      const { stderr, stdout } = await capture(() => secondBackend.initializeSchema());

      for (const pattern of NOISE_PATTERNS) {
        expect(stderr).not.toMatch(pattern);
      }
      // The introspection guard returns early — no DDL is issued, so the
      // "Initializing..." banner should never even appear.
      expect(stdout).not.toContain("Initializing");
    } finally {
      try {
        await secondBackend.disconnect();
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
  });
});

describe("CLI via subprocess produces clean output on an existing store", () => {
  test("`stats` run twice against the same store emits no DDL noise the second time", () => {
    const dir = mkdtempSync(join(tmpdir(), `mg-cli-idem-${Date.now()}-`));
    const storePath = join(dir, "falkordblite.db");
    const env = {
      ...process.env,
      MEMORY_BACKEND: "falkordblite",
      MEMORY_FALKORDBLITE_PATH: storePath,
      MEMORY_LOG_LEVEL: "ERROR",
    };

    try {
      // First run creates the schema.
      const first = spawnSync("bun", ["run", CLI, "stats"], { env, encoding: "utf-8", timeout: 30000 });
      expect(first.status ?? -1).toBe(0);

      // Second run against the existing store must NOT emit schema DDL noise.
      const second = spawnSync("bun", ["run", CLI, "stats"], { env, encoding: "utf-8", timeout: 30000 });
      expect(second.status ?? -1).toBe(0);

      for (const pattern of NOISE_PATTERNS) {
        expect(second.stderr).not.toMatch(pattern);
      }
      // Correct output still produced.
      expect(second.stdout).toContain("Memory Database Statistics");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});