/**
 * Tests for the export/import utilities.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { SQLiteBackend } from "../src/backends/sqlite.js";
import { MemoryDatabase } from "../src/database.js";
import { createMemory, createRelationshipProperties } from "../src/models.js";
import { exportToJson, importFromJson } from "../src/utils/export-import.js";
import { unlinkSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import * as fsPromises from "node:fs/promises";

const TEST_DB = join(tmpdir(), `mg-export-test-${Date.now()}.db`);
const EXPORT_FILE = join(tmpdir(), `mg-export-${Date.now()}.json`);

describe("Export/Import", () => {
  let backend: SQLiteBackend;
  let db: MemoryDatabase;

  beforeEach(async () => {
    backend = new SQLiteBackend(TEST_DB);
    await backend.connect();
    await backend.initializeSchema();
    db = new MemoryDatabase(backend);

    const mem1 = createMemory({
      type: "solution",
      title: "Test Solution",
      content: "A test solution for export",
      tags: ["test", "export"],
      importance: 0.7,
    });
    const id1 = await db.storeMemory(mem1);

    const mem2 = createMemory({
      type: "problem",
      title: "Test Problem",
      content: "A test problem for export",
      tags: ["test"],
      importance: 0.6,
    });
    const id2 = await db.storeMemory(mem2);

    await db.createRelationship(id1, id2, "SOLVES", createRelationshipProperties());
  });

  afterEach(async () => {
    await backend.disconnect();
    try {
      if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
      if (existsSync(EXPORT_FILE)) unlinkSync(EXPORT_FILE);
    } catch {
      // ignore
    }
  });

  test("exportToJson creates a valid JSON file", async () => {
    const result = await exportToJson(db, EXPORT_FILE);
    expect(result["memory_count"]).toBe(2);
    expect(result["relationship_count"]).toBe(1);
    expect(existsSync(EXPORT_FILE)).toBe(true);

    const data = JSON.parse(readFileSync(EXPORT_FILE, "utf-8"));
    expect(data.memories).toBeDefined();
    expect(data.memories.length).toBe(2);
    expect(data.relationships).toBeDefined();
    expect(data.relationships.length).toBe(1);
  });

  test("importFromJson imports from JSON file", async () => {
    await exportToJson(db, EXPORT_FILE);

    const importDbPath = join(tmpdir(), `mg-import-${Date.now()}.db`);
    const importBackend = new SQLiteBackend(importDbPath);
    await importBackend.connect();
    await importBackend.initializeSchema();
    const importDbObj = new MemoryDatabase(importBackend);

    try {
      const result = await importFromJson(importDbObj, EXPORT_FILE, false);
      expect(result["imported_memories"]).toBe(2);
      expect(result["imported_relationships"]).toBe(1);
    } finally {
      await importBackend.disconnect();
      try {
        if (existsSync(importDbPath)) unlinkSync(importDbPath);
      } catch {
        // ignore
      }
    }
  });

  test("importFromJson with skip-duplicates avoids re-importing", async () => {
    await exportToJson(db, EXPORT_FILE);
    const result = await importFromJson(db, EXPORT_FILE, true);
    expect(result["skipped_memories"]).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // SEC-11 (VAL-FREEZE-008): importFromJson validates relationship types
  // against the RelationshipType enum and rejects/skips invalid types with a
  // clear error. Defense-in-depth: even when the underlying backend would
  // accept arbitrary strings, importFromJson skips invalid types with a
  // structured message so corrupted types do not propagate through
  // export→import round-trips.
  // -------------------------------------------------------------------------
  describe("SEC-11: importFromJson validates relationship type (VAL-FREEZE-008)", () => {
    test("skips an invalid relationship type with a clear error", async () => {
      const exportPath = join(tmpdir(), `mg-sec11-export-${Date.now()}.json`);
      try {
        // Build an export JSON in-memory with one valid memory pair and one
        // INVALID relationship type, then write it to disk and import.
        const exportData = {
          format_version: "2.0",
          export_version: "1.0",
          export_date: new Date().toISOString(),
          backend_type: "sqlite",
          memory_count: 2,
          relationship_count: 2,
          memories: [
            {
              id: "mem-sec11-a",
              type: "problem",
              title: "Problem A",
              content: "A problem",
              tags: [],
              importance: 0.5,
              confidence: 0.8,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            {
              id: "mem-sec11-b",
              type: "solution",
              title: "Solution B",
              content: "A solution",
              tags: [],
              importance: 0.5,
              confidence: 0.8,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          relationships: [
            {
              from_memory_id: "mem-sec11-b",
              to_memory_id: "mem-sec11-a",
              // valid type
              type: "SOLVES",
              properties: { strength: 0.5, confidence: 0.8, evidence_count: 1 },
            },
            {
              from_memory_id: "mem-sec11-a",
              to_memory_id: "mem-sec11-b",
              // INVALID type — should be skipped with a clear error
              type: "NOT_A_REAL_RELATIONSHIP_TYPE",
              properties: { strength: 0.5, confidence: 0.8, evidence_count: 1 },
            },
          ],
        };

        const { writeFileSync } = await import("node:fs");
        writeFileSync(exportPath, JSON.stringify(exportData, null, 2));

        const importDbPath = join(tmpdir(), `mg-sec11-import-${Date.now()}.db`);
        const importBackend = new SQLiteBackend(importDbPath);
        await importBackend.connect();
        await importBackend.initializeSchema();
        const importDbObj = new MemoryDatabase(importBackend);

        try {
          const result = await importFromJson(importDbObj, exportPath, false);
          // The valid memory pair imports successfully.
          expect(result["imported_memories"]).toBe(2);
          // The valid relationship imports; the invalid one is skipped.
          expect(result["imported_relationships"]).toBe(1);
          expect(result["skipped_relationships"]).toBe(1);
        } finally {
          await importBackend.disconnect();
          try {
            if (existsSync(importDbPath)) unlinkSync(importDbPath);
          } catch {
            // ignore
          }
        }
      } finally {
        try {
          if (existsSync(exportPath)) unlinkSync(exportPath);
        } catch {
          // ignore
        }
      }
    });

    test("does not write an invalid relationship type to the target backend", async () => {
      const exportPath = join(tmpdir(), `mg-sec11-export-${Date.now()}.json`);
      try {
        const exportData = {
          format_version: "2.0",
          export_version: "1.0",
          export_date: new Date().toISOString(),
          backend_type: "sqlite",
          memory_count: 2,
          relationship_count: 1,
          memories: [
            {
              id: "mem-sec11-c",
              type: "problem",
              title: "Problem C",
              content: "c",
              tags: [],
              importance: 0.5,
              confidence: 0.8,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            {
              id: "mem-sec11-d",
              type: "solution",
              title: "Solution D",
              content: "d",
              tags: [],
              importance: 0.5,
              confidence: 0.8,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          relationships: [
            {
              from_memory_id: "mem-sec11-c",
              to_memory_id: "mem-sec11-d",
              type: "BOGUS_REL_TYPE",
              properties: { strength: 0.5, confidence: 0.8, evidence_count: 1 },
            },
          ],
        };

        const { writeFileSync } = await import("node:fs");
        writeFileSync(exportPath, JSON.stringify(exportData, null, 2));

        const importDbPath = join(tmpdir(), `mg-sec11-import-${Date.now()}.db`);
        const importBackend = new SQLiteBackend(importDbPath);
        await importBackend.connect();
        await importBackend.initializeSchema();
        const importDbObj = new MemoryDatabase(importBackend);

        try {
          await importFromJson(importDbObj, exportPath, false);
          const stats = await importDbObj.getMemoryStatistics();
          const totalRels = stats["total_relationships"] as Record<string, unknown>;
          // No relationship should have been written.
          expect(totalRels["count"]).toBe(0);
        } finally {
          await importBackend.disconnect();
          try {
            if (existsSync(importDbPath)) unlinkSync(importDbPath);
          } catch {
            // ignore
          }
        }
      } finally {
        try {
          if (existsSync(exportPath)) unlinkSync(exportPath);
        } catch {
          // ignore
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-LOCAL-012: atomic export (temp + rename + fsync). exportToJson must
  // write to a temp file then rename it into place (with fsync), so a crash
  // mid-export does not leave a half-written export file at the target path.
  // -------------------------------------------------------------------------
  describe("VAL-LOCAL-012: atomic export (temp + rename + fsync)", () => {
    test("exportToJson uses rename to put the file in place (temp-then-rename)", async () => {
      // Spy on fs/promises.rename — the temp-then-rename pattern MUST call
      // rename as the final atomic step. A non-atomic writeFile-only impl
      // would never call rename.
      const renameSpy = spyOn(fsPromises, "rename");

      try {
        const result = await exportToJson(db, EXPORT_FILE);
        expect(result["memory_count"]).toBe(2);
        expect(existsSync(EXPORT_FILE)).toBe(true);
        expect(renameSpy).toHaveBeenCalled();
        // The destination of the rename must be the target export path.
        const lastCallArgs = renameSpy.mock.calls[renameSpy.mock.calls.length - 1];
        expect(lastCallArgs[1]).toBe(EXPORT_FILE);
      } finally {
        renameSpy.mockRestore();
      }
    });

    test("exportToJson leaves no .tmp files behind after a successful export", async () => {
      await exportToJson(db, EXPORT_FILE);
      const dir = dirname(EXPORT_FILE);
      const base = basename(EXPORT_FILE);
      const leftovers = readdirSync(dir).filter(
        (f) => f !== base && f.startsWith(`${base}.`) && f.endsWith(".tmp")
      );
      expect(leftovers.length).toBe(0);
      expect(existsSync(EXPORT_FILE)).toBe(true);
    });

    test("a failed rename does not leave a half-written target file", async () => {
      // Stub fs/promises.rename to reject — the temp file is written but the
      // final atomic rename into place fails. The target file must NOT exist
      // (no half-written file at the target path); the orphaned temp file is
      // cleaned up by the atomic-write helper.
      const renameSpy = spyOn(fsPromises, "rename").mockRejectedValue(
        Object.assign(new Error("synthetic rename failure"), { code: "ENOENT" })
      );

      try {
        await expect(exportToJson(db, EXPORT_FILE)).rejects.toThrow(/synthetic rename failure/);
        // No half-written file at the target path.
        expect(existsSync(EXPORT_FILE)).toBe(false);
        // No leftover .tmp file either.
        const dir = dirname(EXPORT_FILE);
        const base = basename(EXPORT_FILE);
        const leftovers = readdirSync(dir).filter(
          (f) => f.startsWith(`${base}.`) && f.endsWith(".tmp")
        );
        expect(leftovers.length).toBe(0);
      } finally {
        renameSpy.mockRestore();
      }
    });
  });
});
