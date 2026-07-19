/**
 * Milestone 5 (part 6) — Tier 1 #10 sqlite fallback scoping.
 *
 * Backed by validation-contract assertions:
 *   VAL-LOCAL-032..042 — sqlite fallback prints a clear unsupported message
 *     (no throw, no stack trace) for each intelligence/analytics/proactive
 *     command: entities, patterns, context, visualize, similarity, learning,
 *     gaps, briefing, predict, warn, outcome.
 *   VAL-LOCAL-043..045 — sqlite fallback prints a clear unsupported message
 *     for each temporal command: as-of, history, changes.
 *   VAL-LOCAL-046 — sqlite fallback CRUD cycle (store/get/update/delete/
 *     search) all exit 0 and behave correctly.
 *   VAL-LOCAL-047 — sqlite fallback link/related exit 0 and behave correctly.
 *   VAL-CROSS-004 — cross-check: unsupported-message sweep + CRUD sweep both
 *     pass on sqlite.
 *
 * All tests spawn the real CLI as a subprocess with MEMORY_BACKEND=sqlite and
 * a temp MEMORY_SQLITE_PATH so we exercise the actual entry-point arg
 * parsing, backend factory dispatch, and the isCypherCapable() guard. Never
 * touches ~/.memorygraph.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TS_DIR = join(import.meta.dir, "..");
const CLI = join(TS_DIR, "src", "cli.ts");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function freshTempDir(prefix: string): string {
  return mkdtempSync(
    join(tmpdir(), `mg-sqlite-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`)
  );
}

/**
 * Spawn the CLI as a real subprocess on the sqlite fallback backend with an
 * isolated temp sqlite db path. `keepDir` returns the temp dir for callers
 * that need to share state across multiple CLI invocations on the same store.
 */
function runSqliteCli(
  args: string[],
  opts: { sqlitePath?: string; cwd?: string } = {}
): RunResult {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MEMORY_BACKEND: "sqlite",
    MEMORY_SQLITE_PATH: opts.sqlitePath ?? "(unset)",
    MEMORY_LOG_LEVEL: "ERROR",
  };
  // Ensure a fresh isolated sqlite path unless caller provided one.
  if (!opts.sqlitePath) {
    const dir = freshTempDir("run");
    env.MEMORY_SQLITE_PATH = join(dir, "memory.db");
  }
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? TS_DIR,
    env: childEnv,
    encoding: "utf-8",
    timeout: 30000,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return {
    status: r.status ?? -1,
    stdout,
    stderr,
    combined: stdout + "\n" + stderr,
  };
}

/** A persistent temp sqlite path shared across one CRUD cycle. */
function sharedSqlitePath(): string {
  const dir = freshTempDir("cycle");
  return join(dir, "memory.db");
}

/** Match the "Memory stored successfully with ID: <id>" line and return id. */
function extractMemoryId(stdout: string): string | null {
  const m = stdout.match(/ID:\s*([^\s\n]+)/);
  return m ? m[1] : null;
}

/** Heuristic stack-trace detector — matches typical V8/Bun stack frames. */
const STACK_FRAME_RE = /\n\s+at\s+\S+:\d+:\d+|\n\s+at\s+\S+\s+\(/;

/**
 * Asserts the run produced a clear sqlite-fallback unsupported message and
 * exited cleanly (0 or documented non-success) with NO stack trace /
 * unhandled exception.
 */
function expectSqliteUnsupported(run: RunResult, command: string): void {
  // Exit 0 (or a documented non-success code, but never a crash/signal).
  expect(
    run.status === 0 || run.status === 1,
    `'${command}' on sqlite exited with code ${run.status} (expected 0 or 1, not a signal/crash)`
  ).toBe(true);

  // Clear unsupported message — must mention "not supported" (or "unsupported")
  // AND reference the sqlite fallback AND a Cypher-capable backend requirement.
  const text = run.combined.toLowerCase();
  expect(
    text.includes("not supported") || text.includes("unsupported"),
    `'${command}' on sqlite must print an unsupported message; got: ${run.combined}`
  ).toBe(true);
  expect(
    text.includes("sqlite"),
    `'${command}' unsupported message must reference the sqlite fallback; got: ${run.combined}`
  ).toBe(true);
  expect(
    text.includes("cypher"),
    `'${command}' unsupported message must reference a Cypher-capable backend requirement; got: ${run.combined}`
  ).toBe(true);

  // NO stack trace / unhandled exception.
  expect(
    STACK_FRAME_RE.test(run.combined),
    `'${command}' on sqlite must NOT print a stack trace; got: ${run.combined}`
  ).toBe(false);
  expect(
    /unhandled|UnhandledPromise|TypeError:|ReferenceError:|Error:\s.*\n\s+at/.test(run.combined),
    `'${command}' on sqlite must NOT surface an unhandled exception; got: ${run.combined}`
  ).toBe(false);
}

// ---------------------------------------------------------------------------
// VAL-LOCAL-032..042: intelligence / analytics / proactive unsupported sweep
// ---------------------------------------------------------------------------

describe("sqlite fallback — intelligence/analytics/proactive unsupported sweep (VAL-LOCAL-032..042)", () => {
  test("VAL-LOCAL-032: entities prints unsupported message, no throw", () => {
    const run = runSqliteCli(["entities", "any-id"]);
    expectSqliteUnsupported(run, "entities");
  });

  test("VAL-LOCAL-033: patterns prints unsupported message, no throw", () => {
    const run = runSqliteCli(["patterns", "--query", "auth bug"]);
    expectSqliteUnsupported(run, "patterns");
  });

  test("VAL-LOCAL-034: context prints unsupported message, no throw", () => {
    const run = runSqliteCli(["context", "--query", "auth"]);
    expectSqliteUnsupported(run, "context");
  });

  test("VAL-LOCAL-035: visualize prints unsupported message, no throw", () => {
    const run = runSqliteCli(["visualize"]);
    expectSqliteUnsupported(run, "visualize");
  });

  test("VAL-LOCAL-036: similarity prints unsupported message, no throw", () => {
    // Note: assertion evidence uses `--id <id>`; guard must fire BEFORE arg
    // validation so even a non-positional id form prints the unsupported
    // message (not a usage error).
    const run = runSqliteCli(["similarity", "--id", "some-id"]);
    expectSqliteUnsupported(run, "similarity");
  });

  test("VAL-LOCAL-037: learning prints unsupported message, no throw", () => {
    // Note: assertion evidence uses `--goal g`; guard must fire BEFORE arg
    // validation so even a wrong flag form prints the unsupported message.
    const run = runSqliteCli(["learning", "--goal", "react-auth"]);
    expectSqliteUnsupported(run, "learning");
  });

  test("VAL-LOCAL-038: gaps prints unsupported message, no throw", () => {
    const run = runSqliteCli(["gaps"]);
    expectSqliteUnsupported(run, "gaps");
  });

  test("VAL-LOCAL-039: briefing prints unsupported message, no throw", () => {
    const run = runSqliteCli(["briefing"]);
    expectSqliteUnsupported(run, "briefing");
  });

  test("VAL-LOCAL-040: predict prints unsupported message, no throw", () => {
    const run = runSqliteCli(["predict"]);
    expectSqliteUnsupported(run, "predict");
  });

  test("VAL-LOCAL-041: warn prints unsupported message, no throw", () => {
    const run = runSqliteCli(["warn"]);
    expectSqliteUnsupported(run, "warn");
  });

  test("VAL-LOCAL-042: outcome prints unsupported message, no throw", () => {
    // Note: assertion evidence uses `--id <id> --success true`; guard must
    // fire BEFORE arg validation.
    const run = runSqliteCli(["outcome", "--id", "some-id", "--success", "true"]);
    expectSqliteUnsupported(run, "outcome");
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-043..045: temporal unsupported sweep
// ---------------------------------------------------------------------------

describe("sqlite fallback — temporal unsupported sweep (VAL-LOCAL-043..045)", () => {
  test("VAL-LOCAL-043: as-of prints unsupported message, no throw", () => {
    const run = runSqliteCli(["as-of", "some-id", "2024-01-01T00:00:00Z"]);
    expectSqliteUnsupported(run, "as-of");
  });

  test("VAL-LOCAL-044: history prints unsupported message, no throw", () => {
    const run = runSqliteCli(["history", "some-id"]);
    expectSqliteUnsupported(run, "history");
  });

  test("VAL-LOCAL-045: changes prints unsupported message, no throw", () => {
    const run = runSqliteCli(["changes", "2024-01-01T00:00:00Z"]);
    expectSqliteUnsupported(run, "changes");
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-046: sqlite fallback CRUD cycle still works
// ---------------------------------------------------------------------------

describe("sqlite fallback — CRUD cycle (VAL-LOCAL-046)", () => {
  test("store → get → update → search → delete all exit 0 and behave correctly", () => {
    const sqlitePath = sharedSqlitePath();

    // store
    const storeRun = runSqliteCli(
      ["store", "--type", "solution", "--title", "Sqlite CRUD probe", "--content", "sqlite fallback CRUD content", "--tags", "sqlite,crud"],
      { sqlitePath }
    );
    expect(storeRun.status).toBe(0);
    expect(storeRun.stdout).toContain("stored successfully");
    const id = extractMemoryId(storeRun.stdout);
    expect(id, `could not extract memory id from store output: ${storeRun.stdout}`).not.toBeNull();

    // get
    const getRun = runSqliteCli(["get", id!], { sqlitePath });
    expect(getRun.status).toBe(0);
    expect(getRun.stdout).toContain("Sqlite CRUD probe");
    expect(getRun.stdout).toContain("sqlite fallback CRUD content");

    // update
    const updateRun = runSqliteCli(
      ["update", id!, "--title", "Sqlite CRUD probe v2", "--content", "updated content"],
      { sqlitePath }
    );
    expect(updateRun.status).toBe(0);
    expect(updateRun.stdout).toContain("updated successfully");

    // verify update landed
    const getAfterUpdate = runSqliteCli(["get", id!], { sqlitePath });
    expect(getAfterUpdate.status).toBe(0);
    expect(getAfterUpdate.stdout).toContain("Sqlite CRUD probe v2");
    expect(getAfterUpdate.stdout).toContain("updated content");

    // search
    const searchRun = runSqliteCli(["search", "--query", "updated"], { sqlitePath });
    expect(searchRun.status).toBe(0);
    expect(searchRun.stdout).toContain("Sqlite CRUD probe v2");

    // delete
    const deleteRun = runSqliteCli(["delete", id!], { sqlitePath });
    expect(deleteRun.status).toBe(0);
    expect(deleteRun.stdout).toContain("deleted successfully");

    // verify deletion
    const getAfterDelete = runSqliteCli(["get", id!], { sqlitePath });
    expect(getAfterDelete.status).toBe(0);
    expect(getAfterDelete.stdout).toContain("Memory not found");
  });
});

// ---------------------------------------------------------------------------
// VAL-LOCAL-047: sqlite fallback link/related still work
// ---------------------------------------------------------------------------

describe("sqlite fallback — link/related (VAL-LOCAL-047)", () => {
  test("link and related exit 0 and behave correctly on sqlite", () => {
    const sqlitePath = sharedSqlitePath();

    // store two memories
    const aRun = runSqliteCli(
      ["store", "--type", "problem", "--title", "Problem A", "--content", "problem A content"],
      { sqlitePath }
    );
    expect(aRun.status).toBe(0);
    const aId = extractMemoryId(aRun.stdout);
    expect(aId).not.toBeNull();

    const bRun = runSqliteCli(
      ["store", "--type", "solution", "--title", "Solution B", "--content", "solution B content"],
      { sqlitePath }
    );
    expect(bRun.status).toBe(0);
    const bId = extractMemoryId(bRun.stdout);
    expect(bId).not.toBeNull();

    // link A -> B
    const linkRun = runSqliteCli(
      ["link", aId!, bId!, "SOLVES", "--strength", "0.8"],
      { sqlitePath }
    );
    expect(linkRun.status).toBe(0);
    // Link on sqlite either reports a success message or at least produces
    // non-empty structured output (no throw / no usage error).
    const linkOk = linkRun.stdout.includes("success") || linkRun.stdout.length > 0;
    expect(linkOk, `link produced no output; stdout=${linkRun.stdout} stderr=${linkRun.stderr}`).toBe(true);

    // related for A returns B
    const relatedRun = runSqliteCli(["related", aId!], { sqlitePath });
    expect(relatedRun.status).toBe(0);
    expect(relatedRun.stdout).toContain("Solution B");
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-004: cross-check — unsupported-message sweep + CRUD sweep both pass
// ---------------------------------------------------------------------------

describe("VAL-CROSS-004: sqlite fallback scoping cross-check", () => {
  // The full set of Cypher-only commands that must print an unsupported
  // message on the sqlite fallback.
  const UNSUPPORTED_COMMANDS: Array<{ name: string; args: string[] }> = [
    { name: "entities", args: ["entities", "any-id"] },
    { name: "patterns", args: ["patterns", "--query", "auth"] },
    { name: "context", args: ["context", "--query", "auth"] },
    { name: "visualize", args: ["visualize"] },
    { name: "similarity", args: ["similarity", "--id", "x"] },
    { name: "learning", args: ["learning", "--goal", "g"] },
    { name: "gaps", args: ["gaps"] },
    { name: "briefing", args: ["briefing"] },
    { name: "predict", args: ["predict"] },
    { name: "warn", args: ["warn"] },
    { name: "outcome", args: ["outcome", "--id", "x", "--success", "true"] },
    { name: "as-of", args: ["as-of", "x", "2024-01-01T00:00:00Z"] },
    { name: "history", args: ["history", "x"] },
    { name: "changes", args: ["changes", "2024-01-01T00:00:00Z"] },
  ];

  test("unsupported-message sweep: every Cypher-only command prints a clear message on sqlite, no throw", () => {
    const failures: string[] = [];
    for (const { name, args } of UNSUPPORTED_COMMANDS) {
      const run = runSqliteCli(args);
      try {
        expectSqliteUnsupported(run, name);
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }
    expect(failures, `unsupported-message sweep failures:\n${failures.join("\n")}`).toEqual([]);
  });

  test("CRUD sweep: store/get/update/search/delete + link/related all work on sqlite", () => {
    const sqlitePath = sharedSqlitePath();
    const failures: string[] = [];

    const steps: Array<{ label: string; run: RunResult; expect: (r: RunResult) => void }> = [];

    const storeRun = runSqliteCli(
      ["store", "--type", "solution", "--title", "Cross CRUD", "--content", "cross check content", "--tags", "cross"],
      { sqlitePath }
    );
    steps.push({
      label: "store",
      run: storeRun,
      expect: (r) => {
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("stored successfully");
      },
    });

    const id = extractMemoryId(storeRun.stdout);
    if (!id) {
      failures.push(`store: could not extract id from ${storeRun.stdout}`);
    }

    if (id) {
      const getRun = runSqliteCli(["get", id], { sqlitePath });
      steps.push({
        label: "get",
        run: getRun,
        expect: (r) => {
          expect(r.status).toBe(0);
          expect(r.stdout).toContain("Cross CRUD");
        },
      });

      const updateRun = runSqliteCli(["update", id, "--title", "Cross CRUD v2"], { sqlitePath });
      steps.push({
        label: "update",
        run: updateRun,
        expect: (r) => {
          expect(r.status).toBe(0);
          expect(r.stdout).toContain("updated successfully");
        },
      });

      const searchRun = runSqliteCli(["search", "--query", "cross"], { sqlitePath });
      steps.push({
        label: "search",
        run: searchRun,
        expect: (r) => {
          expect(r.status).toBe(0);
        },
      });

      // second memory for link
      const bRun = runSqliteCli(
        ["store", "--type", "problem", "--title", "Cross Problem", "--content", "cross problem"],
        { sqlitePath }
      );
      const bId = extractMemoryId(bRun.stdout);
      if (!bId) {
        failures.push(`store(B): could not extract id from ${bRun.stdout}`);
      } else {
        const linkRun = runSqliteCli(["link", id, bId, "RELATED_TO", "--strength", "0.5"], { sqlitePath });
        steps.push({
          label: "link",
          run: linkRun,
          expect: (r) => {
            expect(r.status).toBe(0);
          },
        });

        const relatedRun = runSqliteCli(["related", id], { sqlitePath });
        steps.push({
          label: "related",
          run: relatedRun,
          expect: (r) => {
            expect(r.status).toBe(0);
            expect(r.stdout).toContain("Cross Problem");
          },
        });
      }

      const deleteRun = runSqliteCli(["delete", id], { sqlitePath });
      steps.push({
        label: "delete",
        run: deleteRun,
        expect: (r) => {
          expect(r.status).toBe(0);
          expect(r.stdout).toContain("deleted successfully");
        },
      });
    }

    for (const step of steps) {
      try {
        step.expect(step.run);
      } catch (err) {
        failures.push(`${step.label}: ${(err as Error).message}\n  stdout: ${step.run.stdout}\n  stderr: ${step.run.stderr}`);
      }
    }
    expect(failures, `CRUD sweep failures:\n${failures.join("\n")}`).toEqual([]);
  });
});
