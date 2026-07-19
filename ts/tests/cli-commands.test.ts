/**
 * CLI command tests — Milestone 4 (Tier 0 #3 v1.0 freeze).
 *
 * Replaces the previous vacuous CLI test (which asserted the cli.ts source
 * contained `case "<cmd>"` strings) with REAL command execution tests that
 * spawn the CLI as a subprocess and assert stdout + exit codes. Also covers
 * VAL-FREEZE-005 / VAL-FREEZE-006 (parseSimpleArgs `--` end-of-options
 * sentinel and `--key=--value` form) by importing the real `parseSimpleArgs`
 * from cli.ts — no local reimplementation.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseSimpleArgs } from "../src/cli.js";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `bun run src/cli.ts <args>` as a real subprocess with an isolated
 * falkordblite store under a temp dir, so we exercise the actual CLI entry,
 * arg parsing, dispatch, and backend path. Exit codes and stdout are real
 * observable behavior — not source-grep approximations.
 */
function runCli(args: string[], opts: { backend?: string; store?: string } = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), `mg-cli-${Date.now()}-`));
  const env = {
    ...process.env,
    MEMORY_BACKEND: opts.backend ?? "falkordblite",
    MEMORY_FALKORDBLITE_PATH: opts.store ?? join(dir, "falkordblite.db"),
    MEMORY_SQLITE_PATH: join(dir, "sqlite.db"),
    MEMORY_LOG_LEVEL: "ERROR",
  };

  const result = spawnSync("bun", ["run", CLI, ...args], {
    env,
    encoding: "utf-8",
    timeout: 30000,
  });

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// VAL-FREEZE-005 / VAL-FREEZE-006: parseSimpleArgs
// ---------------------------------------------------------------------------

describe("parseSimpleArgs — `--` end-of-options sentinel (VAL-FREEZE-005)", () => {
  test("`--content -- --weird-value` parses --weird-value as the content value", () => {
    const result = parseSimpleArgs(["--content", "--", "--weird-value"]);
    expect(result["content"]).toBe("--weird-value");
  });

  test("args after `--` are positional even if they start with `--`", () => {
    const result = parseSimpleArgs(["--", "--weird-value", "--flag"]);
    expect(result["_positional"]).toEqual(["--weird-value", "--flag"]);
    expect(result["weird-value"]).toBeUndefined();
    expect(result["flag"]).toBeUndefined();
  });

  test("`--flag -- positional` does not consume positional as flag's value", () => {
    // --flag is a boolean; after `--`, everything is positional.
    const result = parseSimpleArgs(["--flag", "--", "positional"]);
    expect(result["flag"]).toBe(true);
    expect(result["_positional"]).toEqual(["positional"]);
  });

  test("`--key -- value extra` (value does not start with --) treats key as boolean", () => {
    // Strict POSIX `--`: when the next arg does NOT start with `--`, the
    // pending key flushes as a boolean and `--` ends options. The user can
    // pass `--`-prefixed values via the `--key=--value` form instead.
    const result = parseSimpleArgs(["--key", "--", "value", "extra"]);
    expect(result["key"]).toBe(true);
    expect(result["_positional"]).toEqual(["value", "extra"]);
  });

  test("`--` at end with pending --key treats key as boolean", () => {
    const result = parseSimpleArgs(["--key", "--"]);
    expect(result["key"]).toBe(true);
  });
});

describe("parseSimpleArgs — `--key=--value` form (VAL-FREEZE-006)", () => {
  test("`--key=--value` parses key as '--value'", () => {
    const result = parseSimpleArgs(["--key=--value"]);
    expect(result["key"]).toBe("--value");
  });

  test("`--content=--weird-value` parses content as '--weird-value'", () => {
    const result = parseSimpleArgs(["--content=--weird-value"]);
    expect(result["content"]).toBe("--weird-value");
  });

  test("`--type=--x --title=--y` parses both --prefixed values", () => {
    const result = parseSimpleArgs(["--type=--x", "--title=--y"]);
    expect(result["type"]).toBe("--x");
    expect(result["title"]).toBe("--y");
  });
});

describe("parseSimpleArgs — baseline behavior (regression)", () => {
  test("parses --key value pairs", () => {
    const result = parseSimpleArgs(["--type", "solution", "--title", "Test"]);
    expect(result["type"]).toBe("solution");
    expect(result["title"]).toBe("Test");
  });

  test("parses boolean flags", () => {
    const result = parseSimpleArgs(["--json", "--dry-run"]);
    expect(result["json"]).toBe(true);
    expect(result["dry-run"]).toBe(true);
  });

  test("parses positional arguments", () => {
    const result = parseSimpleArgs(["abc-123", "def-456", "SOLVES"]);
    const positional = result["_positional"] as string[];
    expect(positional).toEqual(["abc-123", "def-456", "SOLVES"]);
  });

  test("parses mixed positional and flag arguments", () => {
    const result = parseSimpleArgs(["abc-123", "--strength", "0.8", "def-456"]);
    expect(result["_positional"]).toEqual(["abc-123", "def-456"]);
    expect(result["strength"]).toBe("0.8");
  });
});

// ---------------------------------------------------------------------------
// VAL-FREEZE-009: real CLI command execution (replaces the vacuous source-grep)
// ---------------------------------------------------------------------------

describe("Real CLI command execution (VAL-FREEZE-009)", () => {
  test("`memorygraph` with no args prints USAGE and exits 0", () => {
    const r = runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("USAGE");
    expect(r.stdout).toContain("memorygraph <command>");
  });

  test("`memorygraph --help` prints USAGE and exits 0", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("USAGE");
  });

  test("`memorygraph --version` prints version and exits 0", () => {
    const r = runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("memorygraph");
    // v1.0.0 freeze — the version output should reflect the bumped package
    // version.
    expect(r.stdout).toContain("1.0.0");
  });

  test("`memorygraph unknown-cmd` exits non-zero with an Unknown command message", () => {
    const r = runCli(["this-is-not-a-command"]);
    expect(r.code).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain("Unknown command");
  });

  test("`memorygraph config` exits 0 and prints configuration", () => {
    const r = runCli(["config"], { backend: "falkordblite" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("MemoryGraph CLI v1.0.0");
    expect(r.stderr).toContain("Backend:");
  });

  test("`memorygraph health` on sqlite exits 0 and reports Healthy", () => {
    const r = runCli(["health"], { backend: "sqlite" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Healthy");
    expect(r.stderr).toContain("sqlite");
  });

  test("`memorygraph store` then `search` round-trips on sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), `mg-cli-cycle-${Date.now()}-`));
    const sqlitePath = join(dir, "cycle.db");
    try {
      const env = {
        ...process.env,
        MEMORY_BACKEND: "sqlite",
        MEMORY_SQLITE_PATH: sqlitePath,
        MEMORY_LOG_LEVEL: "ERROR",
      };

      const storeResult = spawnSync(
        "bun",
        ["run", CLI, "store", "--type", "solution", "--title", "CliProbe", "--content", "real-execution round-trip", "--tags", "probe"],
        { env, encoding: "utf-8", timeout: 30000 }
      );
      expect(storeResult.status).toBe(0);
      // The store handler prints "Memory stored successfully with ID: <uuid>"
      // to stdout. We assert that structured success message (not the noisy
      // backend log lines that go to stderr).
      expect(storeResult.stdout).toContain("Memory stored successfully with ID:");

      const searchResult = spawnSync(
        "bun",
        ["run", CLI, "search", "--query", "CliProbe"],
        { env, encoding: "utf-8", timeout: 30000 }
      );
      expect(searchResult.status).toBe(0);
      // Search returns the matching memory by title in its structured output.
      expect(searchResult.stdout).toContain("CliProbe");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("`memorygraph store` missing required args exits non-zero with usage", () => {
    const r = runCli(["store"], { backend: "sqlite" });
    expect(r.code).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain("Usage:");
  });

  test("`memorygraph stats` on sqlite exits 0 with structured stats", () => {
    const r = runCli(["stats"], { backend: "sqlite" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Memories:");
  });

  test("CLI imports as a module without auto-launching (regression)", async () => {
    // Importing cli.ts as a module should NOT trigger main(). The Node-safe
    // entry guard means main() only fires when cli.ts is the entry script.
    // We import it under bun's test runtime and assert no USAGE was printed
    // to stdout during import (which would indicate main() ran).
    const dir = mkdtempSync(join(tmpdir(), `mg-cli-import-${Date.now()}-`));
    const env = {
      ...process.env,
      MEMORY_BACKEND: "sqlite",
      MEMORY_SQLITE_PATH: join(dir, "import-check.db"),
      MEMORY_LOG_LEVEL: "ERROR",
    };
    const snippet = `
      import('./src/cli.ts').then((mod) => {
        if (typeof mod.parseSimpleArgs !== 'function') {
          process.exit(2);
        }
        process.exit(0);
      }).catch((err) => {
        console.error('IMPORT_FAIL:', err && err.message);
        process.exit(3);
      });
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", snippet], {
      cwd: join(import.meta.dir, ".."),
      env,
      encoding: "utf-8",
      timeout: 30000,
    });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("USAGE");
    expect(result.stdout).not.toContain("memorygraph <command>");
  });
});
