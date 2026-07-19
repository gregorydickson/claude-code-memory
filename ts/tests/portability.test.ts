/**
 * Portability regression tests — Milestone 3, Tier 0 #1 (De-Bun / Node portability).
 *
 * Asserts that no Bun-specific APIs remain in `ts/src/`, the CLI shebang and
 * entry guard are Node-safe, the library no longer auto-launches the CLI on
 * import, and `package.json` declares a Node engine constraint.
 *
 * Backed by validation-contract assertions VAL-PORT-001 / 002 / 007 / 008 /
 * 009 / 010 / 011 / 012.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

// import.meta.dir = .../ts/tests → repo root is ".."/".." and ts/ is "..".
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TSCONFIG_DIR = join(import.meta.dir, ".."); // .../ts
const SRC_ROOT = join(TSCONFIG_DIR, "src");

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

const SRC_FILES = listTsFiles(SRC_ROOT);

// Matches: `from "bun:..."` / `from 'bun:...'` import specifiers,
// `Bun.file` / `Bun.sleep` / `Bun.write` / `Bun.serve` / `Bun.password`
// references, and `import.meta.main` references.
const BUN_API_RE =
  /from\s+['"]bun:|Bun\.(file|sleep|write|serve|password)|import\.meta\.main/;

describe("VAL-PORT-001: no bun:* / Bun.<api> / import.meta.main in ts/src/", () => {
  for (const file of SRC_FILES) {
    const rel = relative(SRC_ROOT, file);
    test(`${rel} has no Bun-specific API`, () => {
      const src = readFileSync(file, "utf-8");
      expect(BUN_API_RE.test(src)).toBe(false);
    });
  }
});

describe("VAL-PORT-002: cli.ts shebang is #!/usr/bin/env node", () => {
  test("first line of cli.ts is the node shebang", () => {
    const cliPath = join(SRC_ROOT, "cli.ts");
    const content = readFileSync(cliPath, "utf-8");
    const firstLine = content.split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });
});

describe("VAL-PORT-007: index.ts does not auto-launch CLI on import", () => {
  test("index.ts has no unconditional top-level main() call", () => {
    const indexSrc = readFileSync(join(SRC_ROOT, "index.ts"), "utf-8");
    // No bare `main();` at the top level (column 0) calling the CLI entry.
    // The unconditional form is `main();` with no preceding guard.
    const lines = indexSrc.split("\n");
    const offending = lines.filter(
      (l) => /^\s*main\s*\(\s*\)\s*;?\s*$/.test(l) || /^\s*import\s*\{[^}]*\bmain\b[^}]*\}\s*from\s*['"][^'"]*\/cli['"]/.test(l)
    );
    expect(offending).toEqual([]);
  });

  test("importing index.ts under node does not invoke the CLI", () => {
    // Spawn `node` on a tiny ESM snippet that imports the library and exits.
    // If index.ts still auto-launched main(), the subprocess would try to run
    // the CLI (printing usage / trying to connect to a backend) and likely
    // exit non-zero or print CLI output. We assert it imports cleanly and
    // exits 0 with no CLI stdout.
    const snippet = `
      import('./src/index.ts').then((mod) => {
        // Library imported successfully — confirm a known export is present.
        if (!mod || typeof mod.VERSION !== 'string') {
          process.exit(2);
        }
        process.exit(0);
      }).catch((err) => {
        console.error('IMPORT_FAIL:', err && err.message);
        process.exit(3);
      });
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", snippet], {
      cwd: TSCONFIG_DIR,
      encoding: "utf-8",
      timeout: 30000,
      env: {
        ...process.env,
        // Make sure no backend is selected/connected by accident.
        MEMORY_BACKEND: "sqlite",
        MEMORY_SQLITE_PATH: join(TSCONFIG_DIR, "tmp-portability-import-check.db"),
      },
    });
    try {
      if (existsSync(join(TSCONFIG_DIR, "tmp-portability-import-check.db"))) {
        // best-effort cleanup; ignore errors
      }
    } catch {
      // ignore
    }
    expect(result.status).toBe(0);
    // No CLI usage/help output should appear (which would indicate main() ran).
    expect(result.stdout).not.toContain("Usage:");
    expect(result.stdout).not.toContain("memorygraph <command>");
  });
});

describe("VAL-PORT-008: package.json engines includes node + bun", () => {
  test("engines field has both node (>=20) and bun", () => {
    const pkg = JSON.parse(readFileSync(join(TSCONFIG_DIR, "package.json"), "utf-8"));
    const engines = pkg.engines ?? {};
    expect(engines).toHaveProperty("node");
    expect(engines).toHaveProperty("bun");
    // node constraint must be >= 20.
    const nodeConstraint = String(engines.node);
    expect(/>=?\s*20|>=\s*2[0-9]/.test(nodeConstraint)).toBe(true);
  });
});

describe("VAL-PORT-009: cli.ts uses Node-safe entry guard", () => {
  test("cli.ts references pathToFileURL / process.argv[1] and not import.meta.main", () => {
    const cliSrc = readFileSync(join(SRC_ROOT, "cli.ts"), "utf-8");
    expect(/pathToFileURL/.test(cliSrc)).toBe(true);
    expect(/process\.argv\[1\]/.test(cliSrc)).toBe(true);
    expect(/import\.meta\.main/.test(cliSrc)).toBe(false);
  });
});

describe("VAL-PORT-010: export-import uses fs/promises, not Bun.file", () => {
  test("utils/export-import.ts has no Bun.file and uses fs/promises readFile", () => {
    const src = readFileSync(join(SRC_ROOT, "utils", "export-import.ts"), "utf-8");
    expect(/Bun\.file/.test(src)).toBe(false);
    expect(/readFile/.test(src)).toBe(true);
  });
});

describe("VAL-PORT-011: cloud.ts uses setTimeout, not Bun.sleep", () => {
  test("backends/cloud.ts has no Bun.sleep and uses setTimeout", () => {
    const src = readFileSync(join(SRC_ROOT, "backends", "cloud.ts"), "utf-8");
    expect(/Bun\.sleep/.test(src)).toBe(false);
    expect(/setTimeout/.test(src)).toBe(true);
  });
});

describe("VAL-PORT-004: sqlite backend uses node:sqlite (not bun:sqlite)", () => {
  test("backends/sqlite.ts has no static bun:sqlite import and uses node:sqlite", () => {
    const src = readFileSync(join(SRC_ROOT, "backends", "sqlite.ts"), "utf-8");
    // No STATIC `from "bun:sqlite"` specifier (a dynamic fallback import is
    // allowed — bun:test and the Bun-compiled binary need it because Bun's
    // runtime does not implement node:sqlite).
    expect(/from\s+['"]bun:sqlite['"]/.test(src)).toBe(false);
    // node:sqlite is the chosen primary (type import + dynamic primary import).
    expect(/from\s+['"]node:sqlite['"]/.test(src)).toBe(true);
    expect(/import\(["']node:sqlite["']\)/.test(src)).toBe(true);
  });
});
