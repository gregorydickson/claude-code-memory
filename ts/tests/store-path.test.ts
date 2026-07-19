/**
 * Milestone 5 (part 2) — Tier 1 #7 store path.
 *
 * Backed by validation-contract assertions:
 *   VAL-LOCAL-007 — --store CLI flag is honored
 *   VAL-LOCAL-008 — --db-path CLI flag is honored (alias)
 *   VAL-LOCAL-009 — default store path is ./.memorygraph/ (cwd-relative)
 *   VAL-LOCAL-010 — MEMORY_FALKORDBLITE_PATH env override still works
 *   VAL-CROSS-007 — store path isolation across validators
 *
 * All tests spawn the real CLI as a subprocess on a temp store so we
 * exercise the actual entry-point arg parsing, config wiring, and backend
 * path resolution. Never touches ~/.memorygraph.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const TS_DIR = join(import.meta.dir, "..");
const CLI = join(TS_DIR, "src", "cli.ts");
const CONFIG_TS = join(TS_DIR, "src", "config.ts");

function freshTempDir(prefix: string): string {
  return mkdtempSync(
    join(tmpdir(), `mg-store-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`)
  );
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI as a real subprocess. `opts.env` overlays process.env;
 * set a key to `undefined` to delete it from the child env.
 */
function runCli(
  args: string[],
  opts: { env?: Record<string, string | undefined>; cwd?: string } = {}
): RunResult {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  // Bun's spawnSync env requires string values; drop undefined entries.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? TS_DIR,
    env: childEnv,
    encoding: "utf-8",
    timeout: 60000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Store a memory with a unique token and return the token used. */
function storeProbe(
  storeFlag: string,
  storeValue: string,
  token: string,
  opts: { env?: Record<string, string | undefined>; cwd?: string } = {}
): RunResult {
  return runCli(
    [storeFlag, storeValue, "store", "--content", `store-path probe ${token}`, "--tags", "probe", "--type", "solution", "--title", `Probe ${token}`],
    opts
  );
}

/** Search for a token in a given store. */
function searchProbe(
  storeFlag: string,
  storeValue: string,
  token: string,
  opts: { env?: Record<string, string | undefined>; cwd?: string } = {}
): RunResult {
  return runCli([storeFlag, storeValue, "search", "--query", token], opts);
}

describe("VAL-LOCAL-009: default store path is ./.memorygraph/ (cwd-relative)", () => {
  test("config.ts source contains a cwd-relative default store path", () => {
    const src = readFileSync(CONFIG_TS, "utf-8");
    // Contract grep (ERE): \.\./.memorygraph | \./\.memorygraph | cwd
    // I.e. the source must contain a "./.memorygraph" cwd-relative default
    // or a cwd-based expression.
    expect(
      src.includes("./.memorygraph") ||
        src.includes("../.memorygraph") ||
        src.includes("cwd")
    ).toBe(true);
  });

  test("config.ts default store path is cwd-relative (./.memorygraph)", () => {
    const src = readFileSync(CONFIG_TS, "utf-8");
    // The DEFAULT store path must be the literal cwd-relative form
    // "./.memorygraph", NOT a homedir()-derived absolute path.
    expect(src).toContain("./.memorygraph");
  });

  test("running the CLI in a fresh cwd creates ./.memorygraph/ in that cwd", () => {
    const freshCwd = freshTempDir("default-cwd");
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_FALKORDBLITE_PATH;
      delete env.MEMORY_STORE_PATH;
      delete env.MEMORY_SQLITE_PATH;

      const r = runCli(["health"], { env, cwd: freshCwd });
      expect(r.status, `health stdout: ${r.stdout}\nhealth stderr: ${r.stderr}`).toBe(0);

      const localMg = join(freshCwd, ".memorygraph");
      expect(existsSync(localMg), `expected ${localMg} to exist`).toBe(true);
    } finally {
      try {
        rmSync(freshCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("default store does NOT create a new probe entry under ~/.memorygraph", () => {
    const freshCwd = freshTempDir("default-cwd-nohome");
    const homeMg = join(homedir(), ".memorygraph");
    const beforeHome = existsSync(homeMg) ? readdirSync(homeMg).length : -1;
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_FALKORDBLITE_PATH;
      delete env.MEMORY_STORE_PATH;
      delete env.MEMORY_SQLITE_PATH;

      const token = "zzz-default-nohome-probe";
      const store = runCli(
        ["store", "--content", `store-path probe ${token}`, "--tags", "probe", "--type", "solution", "--title", `Probe ${token}`],
        { env, cwd: freshCwd }
      );
      expect(store.status, `store stdout: ${store.stdout}\nstore stderr: ${store.stderr}`).toBe(0);

      // The probe's data lives under <freshCwd>/.memorygraph, NOT ~/.memorygraph.
      const localMg = join(freshCwd, ".memorygraph");
      expect(existsSync(localMg)).toBe(true);

      const afterHome = existsSync(homeMg) ? readdirSync(homeMg).length : -1;
      // If ~/.memorygraph didn't exist before (beforeHome === -1), it must
      // still not exist (afterHome === -1). If it did exist, the probe must
      // not have added a new top-level entry.
      if (beforeHome === -1) {
        expect(afterHome).toBe(-1);
      } else {
        expect(afterHome).toBe(beforeHome);
      }
    } finally {
      try {
        rmSync(freshCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("VAL-LOCAL-007: --store CLI flag is honored", () => {
  test("memorygraph --store <tmp> store writes to <tmp>, not ~/.memorygraph", () => {
    const dirA = freshTempDir("store-A");
    const dirB = freshTempDir("store-B");
    try {
      const tokenA = "zzz-store-flag-A-unique";
      const tokenB = "zzz-store-flag-B-unique";

      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_FALKORDBLITE_PATH;
      delete env.MEMORY_SQLITE_PATH;

      const sA = storeProbe("--store", dirA, tokenA, { env });
      expect(sA.status, `store A stdout: ${sA.stdout}\nstore A stderr: ${sA.stderr}`).toBe(0);

      const sB = storeProbe("--store", dirB, tokenB, { env });
      expect(sB.status, `store B stdout: ${sB.stdout}\nstore B stderr: ${sB.stderr}`).toBe(0);

      // dirA contains the falkordblite db file
      const dirAEntries = readdirSync(dirA);
      expect(dirAEntries.length).toBeGreaterThan(0);

      // Search in A finds tokenA, NOT tokenB
      const searchA = searchProbe("--store", dirA, tokenA, { env });
      expect(searchA.status, `search A stdout: ${searchA.stdout}\nsearch A stderr: ${searchA.stderr}`).toBe(0);
      const aOut = `${searchA.stdout}\n${searchA.stderr}`;
      expect(aOut).toContain(tokenA);
      expect(aOut).not.toContain(tokenB);

      // Search in B finds tokenB, NOT tokenA
      const searchB = searchProbe("--store", dirB, tokenB, { env });
      expect(searchB.status, `search B stdout: ${searchB.stdout}\nsearch B stderr: ${searchB.stderr}`).toBe(0);
      const bOut = `${searchB.stdout}\n${searchB.stderr}`;
      expect(bOut).toContain(tokenB);
      expect(bOut).not.toContain(tokenA);
    } finally {
      try {
        rmSync(dirA, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        rmSync(dirB, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("VAL-LOCAL-008: --db-path CLI flag is honored (alias of --store)", () => {
  test("memorygraph --db-path <tmp> behaves identically to --store <tmp>", () => {
    const dir = freshTempDir("dbpath");
    try {
      const token = "zzz-dbpath-alias-unique";
      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_FALKORDBLITE_PATH;
      delete env.MEMORY_SQLITE_PATH;

      const s = storeProbe("--db-path", dir, token, { env });
      expect(s.status, `store stdout: ${s.stdout}\nstore stderr: ${s.stderr}`).toBe(0);

      // Data is found at <dir>
      const dirEntries = readdirSync(dir);
      expect(dirEntries.length).toBeGreaterThan(0);

      // Search via --db-path finds the token
      const search = searchProbe("--db-path", dir, token, { env });
      expect(search.status, `search stdout: ${search.stdout}\nsearch stderr: ${search.stderr}`).toBe(0);
      expect(`${search.stdout}\n${search.stderr}`).toContain(token);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("--db-path and --store point at the same store (interchangeable for read/write)", () => {
    const dir = freshTempDir("dbpath-xstore");
    try {
      const token = "zzz-xstore-unique";
      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_FALKORDBLITE_PATH;
      delete env.MEMORY_SQLITE_PATH;

      // Store via --store, search via --db-path (same dir)
      const s = storeProbe("--store", dir, token, { env });
      expect(s.status).toBe(0);

      const search = searchProbe("--db-path", dir, token, { env });
      expect(search.status).toBe(0);
      expect(`${search.stdout}\n${search.stderr}`).toContain(token);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("VAL-LOCAL-010: MEMORY_FALKORDBLITE_PATH env override still works", () => {
  test("MEMORY_FALKORDBLITE_PATH=<tmp> redirects the falkordblite store to <tmp>", () => {
    const dir = freshTempDir("env-override");
    const storePath = join(dir, "custom-falkordblite.db");
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_FALKORDBLITE_PATH: storePath,
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_STORE_PATH;
      delete env.MEMORY_SQLITE_PATH;

      // health exits 0
      const health = runCli(["health"], { env });
      expect(health.status, `health stdout: ${health.stdout}\nhealth stderr: ${health.stderr}`).toBe(0);

      // store + search works and uses <storePath>
      const token = "zzz-env-override-unique";
      const s = runCli(
        ["store", "--content", `store-path probe ${token}`, "--tags", "probe", "--type", "solution", "--title", `Probe ${token}`],
        { env }
      );
      expect(s.status, `store stdout: ${s.stdout}\nstore stderr: ${s.stderr}`).toBe(0);

      const search = runCli(["search", "--query", token], { env });
      expect(search.status, `search stdout: ${search.stdout}\nsearch stderr: ${search.stderr}`).toBe(0);
      expect(`${search.stdout}\n${search.stderr}`).toContain(token);

      // The custom db file exists at <storePath>
      expect(existsSync(storePath)).toBe(true);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("MEMORY_FALKORDBLITE_PATH env override takes precedence over --store", () => {
    const storeDir = freshTempDir("store-precedence");
    const envDir = freshTempDir("env-precedence");
    const envStorePath = join(envDir, "env-wins.db");
    try {
      const token = "zzz-precedence-unique";
      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_FALKORDBLITE_PATH: envStorePath,
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_SQLITE_PATH;

      // Pass --store <storeDir> but set MEMORY_FALKORDBLITE_PATH=<envStorePath>.
      // The backend-specific env var wins (per the documented precedence:
      // MEMORY_FALKORDBLITE_PATH > MEMORY_STORE_PATH > default).
      const s = runCli(
        ["--store", storeDir, "store", "--content", `store-path probe ${token}`, "--tags", "probe", "--type", "solution", "--title", `Probe ${token}`],
        { env }
      );
      expect(s.status, `store stdout: ${s.stdout}\nstore stderr: ${s.stderr}`).toBe(0);

      // The data should be at <envStorePath>, not under <storeDir>
      expect(existsSync(envStorePath)).toBe(true);
      const storeDirEntries = readdirSync(storeDir);
      expect(storeDirEntries.length, `storeDir should be empty, got: ${storeDirEntries}`).toBe(0);
    } finally {
      try {
        rmSync(storeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        rmSync(envDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("VAL-CROSS-007: store path isolation across concurrent invocations", () => {
  test("two concurrent invocations with different --store paths see only their own data", () => {
    const dirA = freshTempDir("concurrent-A");
    const dirB = freshTempDir("concurrent-B");
    try {
      const tokenA = "zzz-concurrent-A-unique";
      const tokenB = "zzz-concurrent-B-unique";
      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_FALKORDBLITE_PATH;
      delete env.MEMORY_SQLITE_PATH;

      // Launch both store operations "concurrently" (bun's spawnSync is
      // blocking, so we emulate concurrency by issuing them back-to-back
      // without a search in between; each spawns its own redis-server over
      // its own unix socket derived from its own db path).
      const sA = storeProbe("--store", dirA, tokenA, { env });
      const sB = storeProbe("--store", dirB, tokenB, { env });
      expect(sA.status, `store A stdout: ${sA.stdout}\nstore A stderr: ${sA.stderr}`).toBe(0);
      expect(sB.status, `store B stdout: ${sB.stdout}\nstore B stderr: ${sB.stderr}`).toBe(0);

      // Each store sees only its own data.
      const searchA = searchProbe("--store", dirA, tokenA, { env });
      const searchB = searchProbe("--store", dirB, tokenB, { env });
      expect(searchA.status).toBe(0);
      expect(searchB.status).toBe(0);

      const aOut = `${searchA.stdout}\n${searchA.stderr}`;
      const bOut = `${searchB.stdout}\n${searchB.stderr}`;
      expect(aOut).toContain(tokenA);
      expect(aOut).not.toContain(tokenB);
      expect(bOut).toContain(tokenB);
      expect(bOut).not.toContain(tokenA);
    } finally {
      try {
        rmSync(dirA, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        rmSync(dirB, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("truly concurrent: two parallel spawns with different --store paths both succeed and stay isolated", async () => {
    const dirA = freshTempDir("parallel-A");
    const dirB = freshTempDir("parallel-B");
    try {
      const tokenA = "zzz-parallel-A-unique";
      const tokenB = "zzz-parallel-B-unique";
      const env: Record<string, string | undefined> = {
        ...process.env,
        MEMORY_BACKEND: "falkordblite",
        MEMORY_LOG_LEVEL: "ERROR",
      };
      delete env.MEMORY_FALKORDBLITE_PATH;
      delete env.MEMORY_SQLITE_PATH;

      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) {
        if (v !== undefined) childEnv[k] = v;
      }

      const { spawn } = await import("node:child_process");
      function runAsync(args: string[]): Promise<RunResult> {
        return new Promise((resolve) => {
          const child = spawn(process.execPath, [CLI, ...args], {
            cwd: TS_DIR,
            env: childEnv,
            timeout: 60000,
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d.toString()));
          child.stderr.on("data", (d) => (stderr += d.toString()));
          child.on("close", (code) =>
            resolve({ status: code ?? -1, stdout, stderr })
          );
        });
      }

      // Issue both store operations in parallel.
      const [sA, sB] = await Promise.all([
        runAsync(["--store", dirA, "store", "--content", `store-path probe ${tokenA}`, "--tags", "probe", "--type", "solution", "--title", `Probe ${tokenA}`]),
        runAsync(["--store", dirB, "store", "--content", `store-path probe ${tokenB}`, "--tags", "probe", "--type", "solution", "--title", `Probe ${tokenB}`]),
      ]);
      expect(sA.status, `store A stdout: ${sA.stdout}\nstore A stderr: ${sA.stderr}`).toBe(0);
      expect(sB.status, `store B stdout: ${sB.stdout}\nstore B stderr: ${sB.stderr}`).toBe(0);

      const [qA, qB] = await Promise.all([
        runAsync(["--store", dirA, "search", "--query", tokenA]),
        runAsync(["--store", dirB, "search", "--query", tokenB]),
      ]);
      expect(qA.status).toBe(0);
      expect(qB.status).toBe(0);
      const aOut = `${qA.stdout}\n${qA.stderr}`;
      const bOut = `${qB.stdout}\n${qB.stderr}`;
      expect(aOut).toContain(tokenA);
      expect(aOut).not.toContain(tokenB);
      expect(bOut).toContain(tokenB);
      expect(bOut).not.toContain(tokenA);
    } finally {
      try {
        rmSync(dirA, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        rmSync(dirB, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("config.ts: STORE_PATH getter and precedence", () => {
  test("Config.STORE_PATH reads MEMORY_STORE_PATH with cwd-relative default", async () => {
    const { Config } = await import("../src/config.js");
    const orig = process.env.MEMORY_STORE_PATH;
    try {
      delete process.env.MEMORY_STORE_PATH;
      expect(Config.STORE_PATH).toBe("./.memorygraph");
      process.env.MEMORY_STORE_PATH = "/tmp/mg-store-test-xyz";
      expect(Config.STORE_PATH).toBe("/tmp/mg-store-test-xyz");
    } finally {
      if (orig === undefined) delete process.env.MEMORY_STORE_PATH;
      else process.env.MEMORY_STORE_PATH = orig;
    }
  });

  test("Config.FALKORDBLITE_PATH falls back to STORE_PATH/falkordblite.db", async () => {
    const { Config } = await import("../src/config.js");
    const origStore = process.env.MEMORY_STORE_PATH;
    const origFalk = process.env.MEMORY_FALKORDBLITE_PATH;
    try {
      delete process.env.MEMORY_FALKORDBLITE_PATH;
      delete process.env.MEMORY_STORE_PATH;
      // Default: ./.memorygraph/falkordblite.db
      expect(Config.FALKORDBLITE_PATH).toBe(".memorygraph/falkordblite.db");
      // Via STORE_PATH
      process.env.MEMORY_STORE_PATH = "/tmp/mg-store-xyz";
      expect(Config.FALKORDBLITE_PATH).toBe(join("/tmp/mg-store-xyz", "falkordblite.db"));
      // MEMORY_FALKORDBLITE_PATH wins over STORE_PATH
      process.env.MEMORY_FALKORDBLITE_PATH = "/tmp/explicit.db";
      expect(Config.FALKORDBLITE_PATH).toBe("/tmp/explicit.db");
    } finally {
      if (origStore === undefined) delete process.env.MEMORY_STORE_PATH;
      else process.env.MEMORY_STORE_PATH = origStore;
      if (origFalk === undefined) delete process.env.MEMORY_FALKORDBLITE_PATH;
      else process.env.MEMORY_FALKORDBLITE_PATH = origFalk;
    }
  });

  test("Config.SQLITE_PATH falls back to STORE_PATH/memory.db", async () => {
    const { Config } = await import("../src/config.js");
    const origStore = process.env.MEMORY_STORE_PATH;
    const origSqlite = process.env.MEMORY_SQLITE_PATH;
    try {
      delete process.env.MEMORY_SQLITE_PATH;
      delete process.env.MEMORY_STORE_PATH;
      expect(Config.SQLITE_PATH).toBe(".memorygraph/memory.db");
      process.env.MEMORY_STORE_PATH = "/tmp/mg-store-xyz";
      expect(Config.SQLITE_PATH).toBe(join("/tmp/mg-store-xyz", "memory.db"));
      process.env.MEMORY_SQLITE_PATH = "/tmp/explicit-sqlite.db";
      expect(Config.SQLITE_PATH).toBe("/tmp/explicit-sqlite.db");
    } finally {
      if (origStore === undefined) delete process.env.MEMORY_STORE_PATH;
      else process.env.MEMORY_STORE_PATH = origStore;
      if (origSqlite === undefined) delete process.env.MEMORY_SQLITE_PATH;
      else process.env.MEMORY_SQLITE_PATH = origSqlite;
    }
  });
});
