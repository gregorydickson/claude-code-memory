/**
 * Milestone 7 — P2 cleanup (L1–L6) regression tests.
 *
 * Covers VAL-P2-001 .. VAL-P2-006:
 *  - L1: dead redundant cast removed from the intelligence context module.
 *  - L2: dead confidence branch removed from entity-extraction.ts.
 *  - L3: sqlite project_path filter uses `json_extract` (not LIKE on raw JSON).
 *  - L4: integration modules emit only RelationshipType enum values.
 *  - L5: findAllCycles export removed (pre-closed in M6).
 *  - L6: getProjectFromMemories export removed (pre-closed in M6).
 */
import { describe, test, expect } from "bun:test";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { SQLiteBackend } from "../src/backends/sqlite.js";
import { MemoryDatabase } from "../src/database.js";
import {
  createMemory,
  isRelationshipType,
  RelationshipType,
} from "../src/models.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const INTEGRATION_DIR = join(SRC_ROOT, "integration");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a source file as a string (absolute path). */
function readSrc(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), "utf8");
}

/** Recursively list .ts files under a directory. */
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

// ---------------------------------------------------------------------------
// L1 — dead redundant cast removed from the intelligence context module
// ---------------------------------------------------------------------------

describe("VAL-P2-001 (L1): dead redundant cast removed from intelligence context module", () => {
  test("no `as Memory` / `<Memory> as Memory` redundant cast in context-retrieval.ts", () => {
    const src = readSrc("intelligence/context-retrieval.ts");
    // The flagged redundant cast pattern is gone.
    expect(/<Memory>\s*as\s*Memory/.test(src)).toBe(false);
    expect(/\bas Memory\b/.test(src)).toBe(false);
  });

  test("the previous `summary as ProjectSummary` redundant cast is gone", () => {
    const src = readSrc("intelligence/context-retrieval.ts");
    // The raw `summary as ProjectSummary` downcast (cast an already-object
    // to a typed interface) has been replaced with explicit field
    // extraction. The string `as ProjectSummary` should no longer appear.
    expect(src.includes("as ProjectSummary")).toBe(false);
  });

  test("getProjectContext still returns a typed result without throwing (behavior preserved)", async () => {
    // Behavior preserved: on a non-Cypher backend (sqlite), getProjectContext
    // catches the thrown executeQuery error and returns a structured result
    // (no throw escapes to the caller). The Cypher-capable path returns the
    // typed ProjectSummary shape built from the returned record fields.
    const { ContextRetriever } = await import(
      "../src/intelligence/context-retrieval.js"
    );
    const tmpDir = mkdtempSync(join(tmpdir(), "mg-p2-l1-"));
    const dbPath = join(tmpDir, "test.db");
    const backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    try {
      const retriever = new ContextRetriever(backend);
      const result = await retriever.getProjectContext("nonexistent-project");
      expect(result).toBeDefined();
      // On the non-Cypher backend the catch arm returns `{ error: message }`.
      // The important behavior-preservation invariant is: NO throw escapes
      // and the return value is a plain object (structurally a ProjectSummary
      // variant — all ProjectSummary fields are optional).
      expect(typeof result).toBe("object");
    } finally {
      await backend.disconnect();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// L2 — dead confidence branch removed from entity-extraction.ts
// ---------------------------------------------------------------------------

describe("VAL-P2-002 (L2): dead confidence branch removed from entity-extraction.ts", () => {
  test("the dead `text.endsWith(\"()\")` branch is gone from calculateConfidence", () => {
    const src = readSrc("intelligence/entity-extraction.ts");
    // The dead branch `if (text.endsWith("()")) confidence = 0.9;` is gone.
    expect(/text\.endsWith\(["']\(\)["']\)/.test(src)).toBe(false);
  });

  test("FUNCTION entities keep the default 0.7 confidence (behavior preserved)", async () => {
    // The FUNCTION regex captures group 1 — the function NAME without the
    // trailing `()`. So `getMemory()` -> entity text `getMemory`. The dead
    // branch never fired, so removing it preserves the observable behavior:
    // FUNCTION entities have confidence 0.7 (the default).
    const { extractEntities, EntityType } = await import(
      "../src/intelligence/entity-extraction.js"
    );
    const entities = extractEntities("Call getMemory() to retrieve data", 0.0);
    const funcEntities = entities.filter((e) => e.entity_type === EntityType.FUNCTION);
    expect(funcEntities.length).toBeGreaterThan(0);
    for (const e of funcEntities) {
      // The captured text never contains `()` (group 1 = name only).
      expect(e.text.endsWith("()")).toBe(false);
      // Confidence is the default 0.7 (the dead branch never raised it).
      expect(e.confidence).toBe(0.7);
    }
  });

  test("extractEntities still returns FUNCTION entities (behavior preserved)", async () => {
    const { extractEntities, EntityType } = await import(
      "../src/intelligence/entity-extraction.js"
    );
    const entities = extractEntities("Call getMemory() and parseResult()");
    const funcEntities = entities.filter((e) => e.entity_type === EntityType.FUNCTION);
    expect(funcEntities.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// L3 — sqlite project_path filter uses json_extract
// ---------------------------------------------------------------------------

describe("VAL-P2-003 (L3): sqlite project_path filter uses json_extract", () => {
  test("sqlite.ts uses json_extract for the project_path filter", () => {
    const src = readSrc("backends/sqlite.ts");
    expect(src.includes("json_extract(context, '$.project_path')")).toBe(true);
    // The old brittle LIKE-on-raw-JSON pattern for project_path is gone.
    expect(/context LIKE \? ESCAPE/.test(src)).toBe(false);
    expect(src.includes('%"project_path":"')).toBe(false);
  });

  test("searchMemories filters by project_path via json_extract (exact match)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mg-p2-l3-"));
    const dbPath = join(tmpDir, "test.db");
    const backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    const db = new MemoryDatabase(backend);
    try {
      const matchId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "Match",
          content: "content for the matching project",
          context: { project_path: "/repo/match/path" },
        })
      );
      const decoyId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "Decoy",
          content: "content for a different project",
          context: { project_path: "/repo/other/path" },
        })
      );
      const noContextId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "No context",
          content: "memory with no context at all",
        })
      );

      const results = await db.searchMemories({
        query: undefined,
        terms: [],
        memory_types: [],
        tags: [],
        project_path: "/repo/match/path",
        languages: [],
        frameworks: [],
        min_importance: undefined,
        min_confidence: undefined,
        min_effectiveness: undefined,
        created_after: undefined,
        created_before: undefined,
        limit: 50,
        offset: 0,
        include_relationships: true,
        search_tolerance: "normal",
        match_mode: "any",
        relationship_filter: undefined,
      });

      const ids = results.map((m) => m.id);
      expect(ids).toContain(matchId);
      expect(ids).not.toContain(decoyId);
      expect(ids).not.toContain(noContextId);
    } finally {
      await backend.disconnect();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("json_extract filter matches literally even with % and _ in project_path", async () => {
    // The previous LIKE pattern would treat `%` and `_` as wildcards unless
    // escaped. json_extract + `=` matches the project_path exactly, so a
    // project_path containing `%` and `_` is matched literally without any
    // escaping. A decoy that differs only in the `%`/`_` positions must NOT
    // match.
    const tmpDir = mkdtempSync(join(tmpdir(), "mg-p2-l3b-"));
    const dbPath = join(tmpDir, "test.db");
    const backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    const db = new MemoryDatabase(backend);
    try {
      const literalId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "Literal wildcard project_path",
          content: "content with literal percent and underscore",
          context: { project_path: "/repo/50%_off/path_qux" },
        })
      );
      const decoyId = await db.storeMemory(
        createMemory({
          type: "solution",
          title: "Decoy project_path",
          content: "decoy",
          context: { project_path: "/repo/50Xoff/pathQqux" },
        })
      );

      const results = await db.searchMemories({
        query: undefined,
        terms: [],
        memory_types: [],
        tags: [],
        project_path: "/repo/50%_off/path_qux",
        languages: [],
        frameworks: [],
        min_importance: undefined,
        min_confidence: undefined,
        min_effectiveness: undefined,
        created_after: undefined,
        created_before: undefined,
        limit: 50,
        offset: 0,
        include_relationships: true,
        search_tolerance: "normal",
        match_mode: "any",
        relationship_filter: undefined,
      });

      const ids = results.map((m) => m.id);
      expect(ids).toContain(literalId);
      expect(ids).not.toContain(decoyId);
    } finally {
      await backend.disconnect();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// L4 — integration modules emit only RelationshipType enum values
// ---------------------------------------------------------------------------

describe("VAL-P2-004 (L4): integration rel types aligned to RelationshipType enum", () => {
  test("every relationship type emitted by an integration module is in the RelationshipType enum", () => {
    // Scan every .ts file under ts/src/integration/ for the rel types the
    // modules actually EMIT as edge types:
    //   (a) `RelationshipType.NAME` references,
    //   (b) string literals passed as the 3rd arg to createRelationship,
    //   (c) `:REL` and `:REL1|REL2` Cypher edge-type patterns inside query
    //       template literals.
    // Each emitted token must be a member of the RelationshipType enum.
    const files = listTsFiles(INTEGRATION_DIR);
    expect(files.length).toBeGreaterThan(0);

    const emitted = new Set<string>();

    for (const file of files) {
      const src = readFileSync(file, "utf8");

      // (a) RelationshipType.NAME references.
      const relEnumRef = /RelationshipType\.([A-Z][A-Z0-9_]*)/g;
      let m: RegExpExecArray | null;
      while ((m = relEnumRef.exec(src)) !== null) emitted.add(m[1]!);

      // (b) String literals that appear as a createRelationship rel-type
      // argument. We approximate by scanning each createRelationship call
      // block (up to the matching closing paren of the call) and collecting
      // any all-caps string literal or RelationshipType.X inside it.
      let cursor = 0;
      while (true) {
        const callIdx = src.indexOf("createRelationship(", cursor);
        if (callIdx === -1) break;
        // Find the matching close paren (naive — counts parens).
        let depth = 1;
        let i = callIdx + "createRelationship(".length;
        for (; i < src.length && depth > 0; i++) {
          const ch = src[i]!;
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        const callBlock = src.slice(callIdx, i);
        // Collect RelationshipType.X and all-caps string literals inside.
        const enumRe = /RelationshipType\.([A-Z][A-Z0-9_]*)/g;
        let mm: RegExpExecArray | null;
        while ((mm = enumRe.exec(callBlock)) !== null) emitted.add(mm[1]!);
        const litRe = /["']([A-Z][A-Z0-9_]{2,})["']/g;
        while ((mm = litRe.exec(callBlock)) !== null) emitted.add(mm[1]!);
        cursor = i;
      }

      // (c) `:REL` and `:REL1|REL2` Cypher edge-type patterns. Only scan
      // template-literal chunks (all Cypher queries in this codebase use
      // template literals) that contain Cypher keywords. We deliberately
      // do NOT scan single/double-quoted strings, because non-Cypher
      // regex literals (e.g. `['"]?` in SENSITIVE_PATTERNS, or `(?:RSA ...)`)
      // would otherwise start a "string" span that picks up `:RSA`-style
      // false positives.
      const cypherChunks = src.match(/`[^`]*`/g) ?? [];
      for (const chunk of cypherChunks) {
        if (!/\b(?:MATCH|MERGE|RETURN|WHERE|WITH|OPTIONAL|CREATE|DELETE|SET)\b/i.test(chunk)) {
          continue;
        }
        // `:REL` or `[:REL]` or `[:A|B|C]` — capture each token.
        const edgeRe = /:([A-Z][A-Z0-9_]{2,})/g;
        let em: RegExpExecArray | null;
        while ((em = edgeRe.exec(chunk)) !== null) {
          const tok = em[1]!;
          // Filter out Cypher labels that aren't rel types.
          if (tok === "Memory" || tok === "Entity" || tok === "MemoryVersion") {
            continue;
          }
          emitted.add(tok);
        }
      }
    }

    // Every emitted token must be a member of the RelationshipType enum.
    const invalid: string[] = [];
    for (const tok of emitted) {
      if (!isRelationshipType(tok)) invalid.push(tok);
    }
    // The integration-specific rel types we added to the enum should be
    // present in the emitted set (sanity check that the test exercises them).
    const expectedIntegrationTypes = [
      "INVOLVES",
      "PART_OF",
      "EXECUTED_IN",
      "EXHIBITS",
      "ATTEMPTED_SOLUTION",
      "IN_SESSION",
      "MODIFIES",
      "CREATES",
      "FOUND_IN",
    ];
    for (const t of expectedIntegrationTypes) {
      expect(emitted.has(t)).toBe(true);
    }
    expect(invalid).toEqual([]);
  });

  test("the integration-specific rel types are members of the RelationshipType enum", () => {
    // Direct enum membership check for the rel types the integration
    // modules emit.
    for (const t of [
      "INVOLVES",
      "PART_OF",
      "EXECUTED_IN",
      "EXHIBITS",
      "ATTEMPTED_SOLUTION",
      "IN_SESSION",
      "MODIFIES",
      "CREATES",
      "FOUND_IN",
      "SOLVES",
      "FOLLOWS",
    ]) {
      expect(isRelationshipType(t)).toBe(true);
      expect((RelationshipType as Record<string, string>)[t]).toBe(t);
    }
  });

  test("sqlite createRelationship accepts the integration rel types (SEC-11 alignment)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mg-p2-l4-"));
    const dbPath = join(tmpDir, "test.db");
    const backend = new SQLiteBackend(dbPath);
    await backend.connect();
    await backend.initializeSchema();
    const db = new MemoryDatabase(backend);
    try {
      const aId = await db.storeMemory(
        createMemory({ type: "task", title: "A", content: "a content" })
      );
      const bId = await db.storeMemory(
        createMemory({ type: "solution", title: "B", content: "b content" })
      );
      // These previously would have been rejected by SEC-11 validation;
      // now that the enum includes them, createRelationship accepts them.
      for (const t of ["INVOLVES", "PART_OF", "EXECUTED_IN", "EXHIBITS", "IN_SESSION", "MODIFIES", "CREATES", "FOUND_IN", "ATTEMPTED_SOLUTION"]) {
        await db.createRelationship(aId, bId, t, { strength: 0.5, confidence: 0.8, evidence_count: 1, success_rate: null, context: null, created_at: new Date().toISOString(), last_validated: new Date().toISOString(), validation_count: 0, counter_evidence_count: 0, valid_from: new Date().toISOString(), valid_until: null, recorded_at: new Date().toISOString(), invalidated_by: null });
      }
      // No throw — all accepted.
    } finally {
      await backend.disconnect();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// L5 — findAllCycles export removed (pre-closed in M6)
// ---------------------------------------------------------------------------

describe("VAL-P2-005 (L5): findAllCycles implemented OR export removed", () => {
  test("findAllCycles is NOT present in ts/src/ (export removed in M6)", () => {
    // The stub that threw "not yet implemented" was removed by M6
    // subtract-before-add (#19). The graph finds cycles natively via Cypher
    // path queries and the existing `hasCycle` DFS guard.
    const files = listTsFiles(SRC_ROOT);
    let anyMatch = false;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/findAllCycles/.test(src)) {
        anyMatch = true;
        // If it IS present, it must NOT be a "not yet implemented" stub.
        expect(/not yet implemented|not implemented/i.test(src)).toBe(false);
      }
    }
    // The chosen state (per M6): export removed entirely.
    expect(anyMatch).toBe(false);
  });

  test("hasCycle guard is still present (the cycle-detection surface that replaced findAllCycles)", () => {
    // The M6 proof notes the existing `hasCycle` DFS guard covers the
    // add-relationship cycle case. Confirm it remains in the utils
    // graph-algorithms module.
    const gaPath = join(SRC_ROOT, "utils", "graph-algorithms.ts");
    if (existsSync(gaPath)) {
      const src = readFileSync(gaPath, "utf8");
      expect(src.includes("hasCycle")).toBe(true);
      expect(/not yet implemented|not implemented/i.test(src)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// L6 — getProjectFromMemories export removed (pre-closed in M6)
// ---------------------------------------------------------------------------

describe("VAL-P2-006 (L6): getProjectFromMemories implemented OR removed", () => {
  test("getProjectFromMemories is NOT present in ts/src/ (removed in M6)", () => {
    // The stub returning `null` was removed by M6 subtract-before-add
    // (#19). The graph queries `(:Memory)-[:PART_OF]->(:Entity
    // {type:'project'})` natively instead of grepping the flat memory list.
    const files = listTsFiles(SRC_ROOT);
    let anyMatch = false;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/getProjectFromMemories/.test(src)) {
        anyMatch = true;
        // If present, it must NOT be a `return null` stub.
        expect(/return null/.test(src)).toBe(false);
      }
    }
    expect(anyMatch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M6 never-throw consistency — assertAutoModeSafe inside main try/catch
// ---------------------------------------------------------------------------

describe("VAL-P2-007 (M6 consistency): assertAutoModeSafe inside main try/catch", () => {
  test("cli.ts calls assertAutoModeSafe INSIDE the try block (not before it)", () => {
    const src = readSrc("cli.ts");
    // Locate the main() try block and assert assertAutoModeSafe is inside it.
    const tryIdx = src.indexOf("try {");
    // Find the try block that wraps the command switch (the one containing
    // `switch (command)`).
    const switchIdx = src.indexOf("switch (command)");
    expect(switchIdx).toBeGreaterThan(-1);
    // The try block that contains the switch.
    let mainTryIdx = -1;
    let searchFrom = 0;
    while (true) {
      const idx = src.indexOf("try {", searchFrom);
      if (idx === -1) break;
      // Check this try block contains the switch.
      const endSearch = src.indexOf("} catch", idx);
      if (endSearch > idx && switchIdx > idx && switchIdx < endSearch) {
        mainTryIdx = idx;
        break;
      }
      searchFrom = idx + 1;
    }
    expect(mainTryIdx).toBeGreaterThan(-1);
    const assertIdx = src.indexOf("assertAutoModeSafe(command)");
    expect(assertIdx).toBeGreaterThan(mainTryIdx);
    // And it must be BEFORE the switch (so it runs first inside try).
    expect(assertIdx).toBeLessThan(switchIdx);
    // And NOT before the try block (the old M6-inconsistent position).
    expect(assertIdx).toBeGreaterThan(mainTryIdx);
  });
});
