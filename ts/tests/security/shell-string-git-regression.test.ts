/**
 * Regression test — Tier 0 #2 security hygiene.
 *
 * Scans `ts/src/` and fails if any shell-string git call path is introduced:
 *   - `execSync(<string>)` — execSync always runs its first arg through a shell,
 *     so ANY string-literal first argument is a shell-form call and is forbidden.
 *   - `spawnSync(<string>)` shell form — a string-literal first argument that
 *     contains whitespace (e.g. `"git rev-parse ..."`) is the shell form (a single
 *     binary name never contains whitespace) and is forbidden.
 *   - any `execSync`/`spawnSync` whose first arg is a string literal containing
 *     `git ` (a multi-token git command) — forbidden.
 *   - any `spawnSync(...)` call that opts into `shell: true` — forbidden.
 *
 * The only allowed git invocation is the array form:
 *   `spawnSync("git", <args[]>, { cwd, ... })` — first arg is the bare binary
 *   name `"git"` (no whitespace), no `shell: true`, args passed as an array.
 *
 * See master-plan.md §0 ("Command injection is NOT a live vuln") and Tier 0 #2.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test, expect } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** Recursively collect every .ts file under `dir`. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

interface BadCall {
  file: string;
  line: number;
  callee: "execSync" | "spawnSync";
  snippet: string;
  reason: string;
}

/**
 * Walk a source file's text and find every `execSync(` / `spawnSync(` call site.
 * For each, inspect the first argument: if it is a string literal, apply the
 * rules above. Also scan the call body for `shell: true`.
 */
function findBadGitCalls(absPath: string, content: string): BadCall[] {
  const bad: BadCall[] = [];
  const rel = relative(REPO_ROOT, absPath);

  const callRe = /\b(execSync|spawnSync)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(content)) !== null) {
    const callee = m[1] as "execSync" | "spawnSync";
    const callStart = m.index + m[0].length;

    // Look ahead ~400 chars to capture the call body (enough for one-liners;
    // multi-line calls are also covered because we scan raw content).
    const window = content.slice(callStart, callStart + 400);

    // Compute 1-based line number of the call site.
    const line = content.slice(0, m.index).split("\n").length;
    const snippet = content
      .slice(m.index, Math.min(content.length, m.index + 120))
      .replace(/\s+/g, " ")
      .trim();

    // Detect `shell: true` anywhere in the call body (within the window).
    // This catches the explicit shell form regardless of first-arg shape.
    const shellTrue = /shell\s*:\s*true\b/.test(window);

    // Inspect the first argument: skip leading whitespace, then check if it
    // begins with a string-literal quote.
    const trimmed = window.trimStart();
    const firstChar = trimmed[0];

    if (firstChar === '"' || firstChar === "'" || firstChar === "`") {
      // Extract the string literal body (naive but sufficient for source scans;
      // handles `\` escapes and stops at the matching closing quote).
      const quote = firstChar;
      let end = 1;
      while (end < trimmed.length && trimmed[end] !== quote) {
        if (trimmed[end] === "\\") end += 2;
        else end += 1;
      }
      const strBody = trimmed.slice(1, end);

      if (callee === "execSync") {
        // execSync ALWAYS runs its first arg through a shell — any string
        // literal first arg is a shell-string call and is forbidden.
        bad.push({
          file: rel,
          line,
          callee,
          snippet,
          reason:
            "execSync with a string-literal first argument (shell form) — use spawnSync(\"git\", args[], {cwd}) array form instead",
        });
        continue;
      }

      // spawnSync: a string-literal first arg is the shell form when the literal
      // contains whitespace (a single binary name never does). Also flag any
      // literal containing `git ` as a multi-token git command regardless.
      const hasWhitespace = /\s/.test(strBody);
      const hasGitCommand = /(^|\s)git\s/.test(strBody);
      if (hasWhitespace || hasGitCommand) {
        bad.push({
          file: rel,
          line,
          callee,
          snippet,
          reason:
            "spawnSync with a shell-string first argument (multi-token command) — use spawnSync(\"git\", args[], {cwd}) array form instead",
        });
        continue;
      }
    }

    // Even when the first arg is not a string literal (e.g. a variable), an
    // explicit `shell: true` makes the call shell-form and is forbidden.
    if (shellTrue) {
      bad.push({
        file: rel,
        line,
        callee,
        snippet,
        reason:
          "spawnSync with `shell: true` (shell form) — remove shell:true and use spawnSync(\"git\", args[], {cwd}) array form",
      });
    }
  }

  return bad;
}

function collectBadCalls(): BadCall[] {
  const bad: BadCall[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const content = readFileSync(file, "utf-8");
    bad.push(...findBadGitCalls(file, content));
  }
  return bad;
}

// ---------------------------------------------------------------------------

test("no shell-string git call path exists anywhere under ts/src/", () => {
  const bad = collectBadCalls();
  if (bad.length > 0) {
    const lines = bad.map(
      (b) =>
        `  - ${b.file}:${b.line}  [${b.callee}]  ${b.reason}\n      ${b.snippet}`
    );
    throw new Error(
      `Found ${bad.length} forbidden shell-string / shell-form execSync|spawnSync call(s) under ts/src/. ` +
        `All git invocations must use the array form spawnSync("git", args[], {cwd}).\n${lines.join("\n")}`
    );
  }
  expect(bad).toHaveLength(0);
});

test("the live analyze-project git path uses spawnSync array form (no shell)", () => {
  const file = join(SRC_ROOT, "integration", "project-analysis.ts");
  expect(statSync(file).isFile()).toBe(true);
  const content = readFileSync(file, "utf-8");

  // The safeGit helper must invoke spawnSync with the bare binary "git" and an
  // args array — no shell, no string-literal command.
  expect(/spawnSync\s*\(\s*"git"\s*,/.test(content)).toBe(true);

  // No safeExecSync definition or reference may remain anywhere in ts/src/.
  expect(content.includes("safeExecSync")).toBe(false);

  // No execSync call of any kind may remain in project-analysis.ts.
  expect(/execSync\s*\(/.test(content)).toBe(false);
});

test("detection logic flags known-bad patterns and allows the array form", () => {
  // Known-good: array form with bare binary name, no shell:true.
  const good = `
    import { spawnSync } from "node:child_process";
    function safeGit(args: string[], opts: { cwd: string }) {
      const r = spawnSync("git", args, { stdio: "pipe", ...opts });
      return r.stdout?.toString().trim() ?? null;
    }
  `;
  expect(findBadGitCalls(join(SRC_ROOT, "good.ts"), good)).toHaveLength(0);

  // Bad: execSync with a string literal (always shell form).
  const bad1 = `const x = execSync("git rev-parse --is-inside-work-tree", { cwd });`;
  expect(findBadGitCalls(join(SRC_ROOT, "bad1.ts"), bad1)).toHaveLength(1);

  // Bad: spawnSync with a multi-token string literal (shell form).
  const bad2 = `const y = spawnSync("git status --porcelain", { cwd });`;
  expect(findBadGitCalls(join(SRC_ROOT, "bad2.ts"), bad2)).toHaveLength(1);

  // Bad: spawnSync with shell: true (explicit shell form).
  const bad3 = `const z = spawnSync("git", args, { cwd, shell: true });`;
  expect(findBadGitCalls(join(SRC_ROOT, "bad3.ts"), bad3)).toHaveLength(1);

  // Bad: execSync with a template literal containing git.
  const bad4 = "const w = execSync(`git ${userInput}`, { cwd });";
  expect(findBadGitCalls(join(SRC_ROOT, "bad4.ts"), bad4)).toHaveLength(1);
});
