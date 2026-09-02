/**
 * REGRESSION: the CLI must run (produce real output) when its entry point is
 * reached through a SYMLINK.
 *
 * A `.ts` CLI linked into a PATH bin (e.g. `~/.bun/bin/memorygraph ->
 * …/memorygraph/src/cli.ts`) is invoked with `process.argv[1]` = the symlink
 * path, while `import.meta.url` reflects the RESOLVED realpath of cli.ts.
 *
 * The old entry guard compared only `process.argv[1]` against `import.meta.url`
 * (`pathToFileURL(arg1).href === import.meta.url`). Under a symlink these
 * differ, so `isEntry` evaluated to `false` and `main()` never ran — the CLI
 * exited 0 with NO output for every command (`stats`, `briefing`, `--help`,
 * `--version`, ...). This is exactly the silent-exit regression.
 *
 * This test spawns the CLI via a symlink pointing at `src/cli.ts` and asserts
 * real stdout is produced, for both a no-db command and a db command.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const REAL_CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** Spawn the CLI directly (no symlink) to prove entry recognition is intact. */
function runCliDirect(
  args: string[],
  opts: { backend?: string; store?: string } = {}
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), `mg-direct-${Date.now()}-`));
  const env = {
    ...process.env,
    MEMORY_BACKEND: opts.backend ?? "falkordblite",
    MEMORY_FALKORDBLITE_PATH: opts.store ?? join(dir, "falkordblite.db"),
    MEMORY_SQLITE_PATH: join(dir, "sqlite.db"),
    MEMORY_LOG_LEVEL: "ERROR",
  };
  const result = spawnSync("bun", ["run", REAL_CLI, ...args], {
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

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI through a SYMLINKED entry path, mirroring how it is installed
 * as a global PATH bin. Returns real observable output — not a source-grep.
 */
function runCliViaSymlink(args: string[], opts: { backend?: string; store?: string } = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), `mg-symlink-${Date.now()}-`));
  // Create the symlink in a separate temp bin dir pointing at the real cli.ts
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const linkPath = join(binDir, "memorygraph.ts");
  symlinkSync(REAL_CLI, linkPath);

  const env = {
    ...process.env,
    MEMORY_BACKEND: opts.backend ?? "falkordblite",
    MEMORY_FALKORDBLITE_PATH: opts.store ?? join(dir, "falkordblite.db"),
    MEMORY_SQLITE_PATH: join(dir, "sqlite.db"),
    MEMORY_LOG_LEVEL: "ERROR",
  };

  const result = spawnSync("bun", ["run", linkPath, ...args], {
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

describe("CLI runs when the entry point is reached via a symlink (silent-exit regression)", () => {
  test("`--version` through a symlink prints real output (non-empty stdout)", () => {
    const r = runCliViaSymlink(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("memorygraph");
  });

  test("`stats` through a symlink prints real output, not a silent exit", () => {
    const r = runCliViaSymlink(["stats"]);
    expect(r.code).toBe(0);
    // The regression exited 0 with EMPTY stdout. Guard against that.
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toContain("Memory Database Statistics");
  });

  test("`--help` through a symlink prints usage", () => {
    const r = runCliViaSymlink(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("USAGE:");
  });

  test("`briefing` through a symlink prints briefing output (not silent)", () => {
    const r = runCliViaSymlink(["briefing"]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toContain("Session Briefing");
  });
});

describe("CLI entry guard is precise (does not regress non-entry uses)", () => {
  test("direct script run via bun still runs main()", () => {
    const r = runCliDirect(["stats"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Memory Database Statistics");
  });

  test("importing src/cli.ts as a module does NOT run the CLI main()", async () => {
    // Guard correctness: the entry guard must be false when cli.ts is only
    // imported (not executed), so importing it from a test/library never
    // spuriously triggers the CLI.
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    try {
      // Importing must not run main(); it will load the module and the isEntry
      // guard should be false (argv[1] is this test file, not cli.ts).
      await import(REAL_CLI);
    } finally {
      console.log = origLog;
    }
    // If main() had run it would attempt db connects / print overview — none of
    // that should happen on a bare import.
    expect(captured.join("\n")).not.toContain("Memory Database Statistics");
  });
});