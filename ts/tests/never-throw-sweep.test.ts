/**
 * Never-throw SWEEP test (VAL-CROSS-005).
 *
 * For every CLI command, inject a synthetic backend throw at the integration
 * boundary (via MEMORYGRAPH_TEST_INJECT_THROW=1, which makes BackendFactory
 * return a ThrowingBackend) and assert none of the commands escape an
 * unhandled exception / raw stack trace to the caller.
 *
 * Each command is spawned as a real subprocess (`bun run src/cli.ts …`) so
 * the test exercises the actual CLI entry, the createDb() path, the command
 * dispatch, and the never-throw boundary. Acceptable outcomes:
 *   - exit code 0 (command handled the throw and printed a structured result)
 *   - exit code 1 (command surfaced a generic error message)
 *   - exit code 2 (usage error for missing args — also acceptable, not a throw)
 * NOT acceptable:
 *   - exit code 130 (SIGINT) or 134 (SIGABRT) or 139 (SIGSEGV)
 *   - a raw Node stack trace in stdout/stderr (e.g. "at Object.<anonymous>")
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

interface CmdSpec {
  name: string;
  args: string[];
}

// Every CLI command from the dispatch in cli.ts (34 commands).
// Minimal valid-looking args so the command reaches the backend call path
// where the injected throw fires.
const COMMANDS: CmdSpec[] = [
  { name: "store", args: ["--type", "solution", "--title", "t", "--content", "c"] },
  { name: "get", args: ["fake-id"] },
  { name: "update", args: ["fake-id", "--title", "t"] },
  { name: "delete", args: ["fake-id"] },
  { name: "rm", args: ["fake-id"] },
  { name: "search", args: ["--query", "q"] },
  { name: "recall", args: ["--query", "q"] },
  { name: "related", args: ["fake-id"] },
  { name: "link", args: ["a", "b", "SOLVES"] },
  { name: "stats", args: [] },
  { name: "activity", args: [] },
  { name: "as-of", args: ["fake-id", "2020-01-01T00:00:00Z"] },
  { name: "history", args: ["fake-id"] },
  { name: "changes", args: ["2020-01-01T00:00:00Z"] },
  { name: "context-search", args: ["fake-id"] },
  { name: "contextual-search", args: ["fake-id", "--query", "q"] },
  { name: "entities", args: ["fake-id"] },
  { name: "patterns", args: ["--query", "q"] },
  { name: "context", args: ["--query", "q"] },
  { name: "visualize", args: [] },
  { name: "similarity", args: ["fake-id"] },
  { name: "learning", args: ["--topic", "t"] },
  { name: "gaps", args: [] },
  { name: "briefing", args: [] },
  { name: "predict", args: ["--query", "q"] },
  { name: "warn", args: [] },
  { name: "outcome", args: ["fake-id", "--success", "true"] },
  { name: "capture", args: ["--task", "t"] },
  { name: "analyze-project", args: ["--path", "."] },
  { name: "workflow", args: ["--action", "suggest"] },
  { name: "export", args: ["--format", "json", "--output", "/tmp/mg-sweep-export.json"] },
  { name: "import", args: ["--input", "/tmp/mg-sweep-nonexistent.json"] },
  { name: "migrate", args: ["--to", "sqlite", "--dry-run"] },
  { name: "health", args: [] },
  { name: "config", args: [] },
];

// Stack-trace frame marker. Node prints frames like "    at Object.<anonymous> (/path/file.ts:1:1)".
const STACK_FRAME_RE = /\n\s+at\s+\S+/;

/**
 * Strip the `[memorygraph-debug]` tagged debug-log block from the combined
 * output. The debug log is the SEC-5 "full error is debug-logged" channel —
 * it legitimately contains the full error stack. The surfaced message (what
 * the caller sees) must NOT contain a stack, so we strip the debug block
 * before checking for escaped stack frames.
 *
 * A debug-log block is: a line containing `[memorygraph-debug]`, followed by
 * zero or more `    at ...` stack-frame lines.
 */
function stripDebugLogBlock(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inDebugBlock = false;
  for (const line of lines) {
    if (line.includes("[memorygraph-debug]")) {
      inDebugBlock = true;
      continue;
    }
    if (inDebugBlock && /^\s+at\s+/.test(line)) {
      continue;
    }
    inDebugBlock = false;
    out.push(line);
  }
  return out.join("\n");
}

function runCli(name: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), `mg-sweep-${name}-${Date.now()}-`));
  const env = {
    ...process.env,
    MEMORYGRAPH_TEST_INJECT_THROW: "1",
    MEMORY_FALKORDBLITE_PATH: join(dir, "falkordblite.db"),
    MEMORY_SQLITE_PATH: join(dir, "sqlite.db"),
    // Suppress noisy redis/falkordblite startup logs not relevant to the throw path.
    MEMORY_LOG_LEVEL: "ERROR",
  };

  const result = spawnSync("bun", ["run", CLI, name, ...args], {
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

describe("VAL-CROSS-005: never-throw sweep — every CLI command with an injected backend throw", () => {
  // Sanity: confirm the inject hook actually makes the backend throw and the
  // boundary debug-logs the full error.
  test("MEMORYGRAPH_TEST_INJECT_THROW=1 hits the boundary (sanity)", () => {
    const r = runCli("stats", []);
    const combined = r.stdout + "\n" + r.stderr;
    // The boundary debug-logged the synthetic throw.
    expect(combined).toContain("memorygraph-debug");
    // Exit code is a documented one.
    expect(r.code).toBeGreaterThanOrEqual(0);
    expect(r.code).toBeLessThanOrEqual(2);
    // No raw stack trace escaped into the SURFACED (non-debug) output.
    expect(stripDebugLogBlock(combined)).not.toMatch(STACK_FRAME_RE);
  });

  for (const cmd of COMMANDS) {
    test(`'${cmd.name}' does not escape an unhandled exception`, () => {
      const r = runCli(cmd.name, cmd.args);
      const combined = `${r.stdout}\n${r.stderr}`;

      // Exit code must be a documented one (0, 1, or 2 for usage).
      // 130=SIGINT, 134=SIGABRT, 139=SIGSEGV, -1=timeout/spawn failure.
      expect(r.code).toBeGreaterThanOrEqual(0);
      expect(r.code).toBeLessThanOrEqual(2);

      // No raw Node stack trace should escape into the SURFACED output
      // (the debug-log block is stripped — stack frames are allowed there).
      expect(stripDebugLogBlock(combined)).not.toMatch(STACK_FRAME_RE);

      // The surfaced user-facing result (stdout) must not contain the
      // synthetic SECRET payload. (stderr may contain it inside the
      // [memorygraph-debug]-tagged debug log line — that is the SEC-5
      // "full error is debug-logged" channel, not the surfaced message.)
      expect(r.stdout).not.toContain("SECRET");
      expect(r.stdout).not.toContain("hunter2");
    });
  }
});
