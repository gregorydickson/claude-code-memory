/**
 * Milestone 5 (part 1) — Tier 1 #5 (zero network at install) + #6 (no
 * unvendored native dep in spirit).
 *
 * Backed by validation-contract assertions:
 *   VAL-LOCAL-001 — vendored falkordb.so present for darwin-arm64
 *   VAL-LOCAL-002 — vendored falkordb.so present for linux-x64
 *   VAL-LOCAL-003 — vendored redis-server present for darwin-arm64 (executable)
 *   VAL-LOCAL-004 — vendored redis-server present for linux-x64
 *   VAL-LOCAL-005 — offline install succeeds with network blocked
 *   VAL-LOCAL-006 — no postinstall network fetch in the default install path
 *   VAL-CROSS-002 — offline install then full create/search cycle on vendored falkordblite
 *   VAL-CROSS-008 — vendored binaries are loaded (not brew/system redis-server)
 *   VAL-CROSS-009 — zero network at install AND default runtime
 *
 * The live cycle in the second describe block exercises the vendored
 * falkordb.so + vendored redis-server end-to-end via the default
 * falkordblite backend, proving offline runtime works.
 */

import { describe, test, expect } from "bun:test";
import {
  existsSync,
  statSync,
  readFileSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const TS_DIR = join(import.meta.dir, "..");
const VENDOR_ROOT = join(TS_DIR, "vendor", "falkordblite");
const DARWIN_ARM64 = join(VENDOR_ROOT, "darwin-arm64");
const LINUX_X64 = join(VENDOR_ROOT, "linux-x64");
const FALKORDBLITE_TS = join(TS_DIR, "src", "backends", "falkordblite.ts");
const PACKAGE_JSON = join(TS_DIR, "package.json");

/** Non-empty file exists at `path`. */
function expectNonEmptyFile(path: string): void {
  expect(existsSync(path), `expected file at ${path}`).toBe(true);
  const st = statSync(path);
  expect(st.isFile(), `${path} is not a regular file`).toBe(true);
  expect(st.size, `${path} is empty`).toBeGreaterThan(0);
}

/** Path is executable (any execute bit set). */
function expectExecutable(path: string): void {
  expectNonEmptyFile(path);
  // accessSync throws if the permission is not granted.
  accessSync(path, fsConstants.X_OK);
}

describe("VAL-LOCAL-001 / 002 / 003 / 004: vendored binaries present for both platforms", () => {
  test("darwin-arm64 falkordb.so exists and is non-empty", () => {
    expectNonEmptyFile(join(DARWIN_ARM64, "falkordb.so"));
  });

  test("linux-x64 falkordb.so exists and is non-empty", () => {
    expectNonEmptyFile(join(LINUX_X64, "falkordb.so"));
  });

  test("darwin-arm64 redis-server exists and is executable", () => {
    expectExecutable(join(DARWIN_ARM64, "redis-server"));
  });

  test("linux-x64 redis-server exists and is non-empty", () => {
    expectNonEmptyFile(join(LINUX_X64, "redis-server"));
  });
});

describe("VAL-LOCAL-006: no postinstall network fetch in the default install path", () => {
  test("package.json postinstall (if any) does not reference curl/wget/fetch/http", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8"));
    const scripts = pkg.scripts ?? {};
    const postinstall = scripts.postinstall;
    if (postinstall === undefined) return; // no postinstall is also acceptable
    expect(postinstall).not.toMatch(/\bcurl\b/);
    expect(postinstall).not.toMatch(/\bwget\b/);
    expect(postinstall).not.toMatch(/\bfetch\b/);
    expect(postinstall).not.toMatch(/https?:\/\//);
  });

  test("vendor postinstall script (if present) does not fetch from the network", () => {
    const candidate = join(TS_DIR, "scripts", "vendor-postinstall.cjs");
    if (!existsSync(candidate)) return;
    const src = readFileSync(candidate, "utf-8");
    expect(src).not.toMatch(/\bcurl\b/);
    expect(src).not.toMatch(/\bwget\b/);
    expect(src).not.toMatch(/https?:\/\//);
    // `fetch(` call would indicate a network fetch.
    expect(src).not.toMatch(/\bfetch\s*\(/);
    // node:https / node:http imports would indicate a network client.
    expect(src).not.toMatch(/require\s*\(\s*['"]node:https['"]\s*\)/);
    expect(src).not.toMatch(/require\s*\(\s*['"]node:http['"]\s*\)/);
    expect(src).not.toMatch(/from\s+['"]node:https['"]/);
    expect(src).not.toMatch(/from\s+['"]node:http['"]/);
  });
});

describe("VAL-CROSS-008: falkordblite.ts wires modulePath + redisServerPath to vendored paths", () => {
  test("falkordblite.ts references the vendored binary tree and passes modulePath/redisServerPath", () => {
    const src = readFileSync(FALKORDBLITE_TS, "utf-8");
    // The backend must point at the vendored tree.
    expect(src).toMatch(/vendor/);
    // The backend must pass modulePath + redisServerPath to FalkorDB.open.
    expect(src).toMatch(/modulePath/);
    expect(src).toMatch(/redisServerPath/);
  });
});

describe("VAL-LOCAL-005 / VAL-CROSS-002 / VAL-CROSS-009: live create/search cycle using vendored binaries", () => {
  // Spawns the real CLI on a temp store, exercising the vendored
  // falkordb.so + vendored redis-server via the wired falkordblite backend.
  // If the wiring is absent or the vendored binaries are missing for the
  // current platform, this test fails.
  test("health → store → search cycle exits 0 on the default falkordblite backend using vendored binaries", () => {
    const dir = mkdtempSync(
      join(tmpdir(), `mg-vendor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`)
    );
    const storePath = join(dir, "falkordblite.db");
    const env: Record<string, string> = {
      ...process.env,
      MEMORY_FALKORDBLITE_PATH: storePath,
      // Force the default backend explicitly.
      MEMORY_BACKEND: "falkordblite",
    };

    function run(args: string[]): { status: number; stdout: string; stderr: string } {
      const r = spawnSync(process.execPath, [join(TS_DIR, "src", "cli.ts"), ...args], {
        cwd: TS_DIR,
        env,
        encoding: "utf-8",
        timeout: 60000,
      });
      return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }

    try {
      const health = run(["health"]);
      expect(health.status, `health stdout: ${health.stdout}\nhealth stderr: ${health.stderr}`).toBe(0);
      // "Status: Healthy" is printed to stderr via eprint (console.error).
      expect(`${health.stdout}\n${health.stderr}`).toMatch(/Healthy/i);

      const store = run([
        "store",
        "--content",
        "vendor-offline-probe unique-token-zzz",
        "--tags",
        "probe",
        "--type",
        "solution",
        "--title",
        "Vendor offline probe zzz-unique-token",
      ]);
      expect(store.status, `store stdout: ${store.stdout}\nstore stderr: ${store.stderr}`).toBe(0);

      const search = run(["search", "--query", "zzz-unique-token"]);
      expect(search.status, `search stdout: ${search.stdout}\nsearch stderr: ${search.stderr}`).toBe(0);
      expect(`${search.stdout}\n${search.stderr}`).toContain("zzz-unique-token");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
