/**
 * M7 part 3 — bottom-catch never-throw consistency (VAL-P2-008).
 *
 * The AGENTS.md normative rule requires: "ALL CLI entry guards, including
 * the bottom `if(isMain)` catch in `cli.ts`, must surface unhandled errors
 * through `surfaceGenericError` / `neverThrowBoundary` — never print raw
 * `err.message` directly." The M6 scrutiny flagged that the bottom
 * `main().catch` still printed `Fatal: ${err.message}` raw, bypassing the
 * never-throw wrapper. This test closes that gap.
 *
 * Approach: a TEST-ONLY env hook (`MEMORYGRAPH_TEST_INJECT_BOTTOM_CATCH_THROW=1`)
 * throws a synthetic error (with a SECRET payload) BEFORE the main try/catch
 * in `cli.ts`, so `main()` rejects and the bottom `main().catch` fires. The
 * test asserts:
 *   - exit code is 1 (a documented exit, NOT 130/134/139/-1)
 *   - the surfaced output (stdout) does NOT contain the SECRET payload
 *   - the surfaced output (with the [memorygraph-debug] block stripped) does
 *     NOT contain a raw stack trace
 *   - the full error IS debug-logged under the [memorygraph-debug] tag in
 *     stderr (SEC-5: full error lives in the debug log, not the surfaced
 *     message)
 *   - the surfaced text is the generic `surfaceGenericError` message (not
 *     the raw `Fatal: <err.message>` form)
 *
 * A source-level grep assertion also confirms the bottom catch in cli.ts
 * routes through `surfaceGenericError` and does NOT print raw `err.message`
 * via the `Fatal: ${err...}` template.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli.ts");
const CLI_SRC = readFileSync(CLI, "utf8");

// Stack-trace frame marker. Node prints frames like
// "    at Object.<anonymous> (/path/file.ts:1:1)".
const STACK_FRAME_RE = /\n\s+at\s+\S+/;

/**
 * Strip the `[memorygraph-debug]` tagged debug-log block from combined
 * output. The debug log legitimately contains the full error stack (SEC-5);
 * the surfaced message must NOT, so we strip the debug block before
 * checking for escaped stack frames. Mirrors the helper in
 * never-throw-sweep.test.ts.
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

function runCliWithBottomCatchThrow(): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    "bun",
    ["run", CLI, "health"],
    {
      env: {
        ...process.env,
        // Triggers the throw BEFORE the main try/catch so main() rejects
        // and the bottom `main().catch` fires.
        MEMORYGRAPH_TEST_INJECT_BOTTOM_CATCH_THROW: "1",
        // Suppress noisy redis/falkordblite startup logs.
        MEMORY_LOG_LEVEL: "ERROR",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("VAL-P2-008: bottom main().catch routes through surfaceGenericError (never-throw)", () => {
  test("cli.ts bottom catch calls surfaceGenericError (source-level grep)", () => {
    // The bottom `main().catch` block must call surfaceGenericError and
    // must NOT print raw `err.message` via the `Fatal: ${err...}` template.
    //
    // Locate the bottom-catch block (the `main().catch(` near the end of
    // the file) and assert it routes through surfaceGenericError.
    const catchIdx = CLI_SRC.lastIndexOf("main().catch(");
    expect(catchIdx).toBeGreaterThan(-1);
    // The catch block runs to the end of the file from catchIdx.
    const tail = CLI_SRC.slice(catchIdx);
    expect(tail.includes("surfaceGenericError")).toBe(true);
    // The raw `Fatal: ${err...}` template must NOT be present in the
    // bottom-catch block.
    expect(/Fatal:\s*\$\{err/.test(tail)).toBe(false);
    // No direct `err.message` / `err instanceof Error ? err.message` print
    // in the bottom-catch block.
    expect(/err instanceof Error \? err\.message/.test(tail)).toBe(false);
  });

  test("bottom catch surfaces a generic message (no SECRET, no raw stack) when a synthetic error escapes the inner try/catch", () => {
    const r = runCliWithBottomCatchThrow();

    // Exit code must be a documented one (1 = surfaced error). NOT 130
    // (SIGINT), 134 (SIGABRT), 139 (SIGSEGV), or -1 (timeout/spawn fail).
    expect(r.code).toBe(1);

    const combined = `${r.stdout}\n${r.stderr}`;

    // The surfaced message (stdout) must NOT contain the SECRET payload.
    expect(r.stdout).not.toContain("SECRET");
    expect(r.stdout).not.toContain("hunter2");

    // No raw stack trace escapes into the SURFACED (non-debug) output.
    expect(stripDebugLogBlock(combined)).not.toMatch(STACK_FRAME_RE);

    // The surfaced text is the generic surfaceGenericError message, NOT
    // the raw `Fatal: <err.message>` form. The generic message is written
    // via `eprint` (console.error → stderr), so check stderr after
    // stripping the [memorygraph-debug] block.
    const surfacedStderr = stripDebugLogBlock(r.stderr);
    expect(surfacedStderr).not.toMatch(/^Fatal:/);
    expect(surfacedStderr).toMatch(/internal error occurred/i);
  });

  test("bottom catch debug-logs the full error (SEC-5: full error lives in the debug log)", () => {
    const r = runCliWithBottomCatchThrow();

    // The full error (with SECRET) is debug-logged under the
    // [memorygraph-debug] tag in stderr.
    expect(r.stderr).toContain("[memorygraph-debug]");
    expect(r.stderr).toContain("SECRET");
    // The debug log identifies the operation as the bottom catch.
    expect(r.stderr.toLowerCase()).toMatch(/bottom catch|cli entry/);
  });
});
