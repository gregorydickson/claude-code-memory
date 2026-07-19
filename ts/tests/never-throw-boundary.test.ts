/**
 * Never-throw SDK/integration boundary tests (VAL-FAILOPEN-005, 006).
 *
 * Verifies:
 *  - A synthetic backend throw injected at the SDK entry does NOT escape to
 *    the caller; the wrapper returns a structured { isError, text } object.
 *  - SEC-5: the surfaced message is generic (no sensitive data / raw stack),
 *    while the full error is debug-logged.
 */

import { describe, test, expect } from "bun:test";

import { handleStoreMemory, handleGetMemory, handleUpdateMemory, handleDeleteMemory } from "../src/tools/memory.js";
import { handleSearchMemories, handleRecallMemories } from "../src/tools/search.js";
import { handleCreateRelationship, handleGetRelatedMemories } from "../src/tools/relationship.js";
import { handleGetMemoryStatistics, handleGetRecentActivity, handleSearchRelationshipsByContext } from "../src/tools/activity.js";
import { handleQueryAsOf, handleGetRelationshipHistory, handleWhatChanged } from "../src/tools/temporal.js";
import { neverThrowBoundary, debugLogError, surfaceGenericError } from "../src/tools/error-handling.js";
import type { IMemoryDatabase } from "../src/database.js";

/** A db whose every method throws an Error containing a sensitive payload. */
function throwingDb(): IMemoryDatabase {
  const boom = () => {
    throw new Error("backend exploded: SECRET=password=hunter2, token=abc123");
  };
  const asyncBoom = async () => {
    throw new Error("backend exploded: SECRET=password=hunter2, token=abc123");
  };
  return {
    initializeSchema: asyncBoom as any,
    close: asyncBoom as any,
    storeMemory: asyncBoom as any,
    getMemory: asyncBoom as any,
    searchMemories: asyncBoom as any,
    updateMemory: asyncBoom as any,
    deleteMemory: asyncBoom as any,
    createRelationship: asyncBoom as any,
    getRelatedMemories: asyncBoom as any,
    getMemoryStatistics: asyncBoom as any,
    getRecentActivity: asyncBoom as any,
  } as IMemoryDatabase;
}

describe("VAL-FAILOPEN-005: never-throw boundary wrapper", () => {
  test("neverThrowBoundary returns structured error instead of throwing", async () => {
    const wrapped = neverThrowBoundary("test op", async () => {
      throw new Error("synthetic throw with SECRET payload");
    });
    const result = await wrapped();
    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
    expect(typeof result.text).toBe("string");
    // No SECRET leaks to the surfaced message.
    expect(result.text).not.toContain("SECRET");
    expect(result.text).not.toContain("hunter2");
    // Generic message, no raw stack.
    expect(result.text).not.toMatch(/at\s+\w+\s+\(/); // no "at Function (" stack frames
  });

  test("neverThrowBoundary passes through successful { isError, text } results", async () => {
    const wrapped = neverThrowBoundary("test op", async () => {
      return { isError: false, text: "all good" };
    });
    const result = await wrapped();
    expect(result.isError).toBe(false);
    expect(result.text).toBe("all good");
  });

  test("neverThrowBoundary catches synchronous throws too", async () => {
    const wrapped = neverThrowBoundary("test op", (() => {
      throw new Error("sync throw with SECRET");
    }) as any);
    const result = await wrapped();
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("SECRET");
  });

  test("neverThrowBoundary catches non-Error throws (string)", async () => {
    const wrapped = neverThrowBoundary("test op", (async () => {
      throw "string throw with SECRET";
    }) as any);
    const result = await wrapped();
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("SECRET");
  });

  test("handleStoreMemory with a throwing db does not escape; surfaces generic message", async () => {
    const db = throwingDb();
    const result = await handleStoreMemory(db, {
      type: "solution",
      title: "t",
      content: "c",
      tags: [],
      importance: 0.5,
    });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("SECRET");
    expect(result.text).not.toContain("hunter2");
    // No raw stack frames in surfaced text.
    expect(result.text).not.toMatch(/at\s+\w+\s+\(/);
  });

  test("handleSearchMemories with a throwing db does not escape", async () => {
    const db = throwingDb();
    const result = await handleSearchMemories(db, { query: "x" } as any);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("SECRET");
  });

  test("handleGetRelatedMemories with a throwing db does not escape", async () => {
    const db = throwingDb();
    const result = await handleGetRelatedMemories(db, { memory_id: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("SECRET");
  });

  test("handleQueryAsOf with a throwing db does not escape", async () => {
    const db = throwingDb();
    const result = await handleQueryAsOf(db, {
      memory_id: "x",
      as_of: "2020-01-01T00:00:00Z",
    });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("SECRET");
  });
});

describe("VAL-FAILOPEN-006: SEC-5 generic surfaced message + full debug log", () => {
  test("debugLogError emits the full error (with SECRET) to the debug log", () => {
    const stderrChunks: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      stderrChunks.push(args.map((a) => String(a)).join(" "));
    };
    try {
      debugLogError("test op", new Error("backend exploded: SECRET=password=hunter2"));
    } finally {
      console.error = origErr;
    }
    const debug = stderrChunks.join("\n");
    // Full error is debug-logged.
    expect(debug).toContain("SECRET");
    expect(debug).toContain("hunter2");
    expect(debug).toContain("test op");
    // Tagged as debug so consumers can identify it.
    expect(debug).toMatch(/memorygraph-debug/i);
  });

  test("surfaceGenericError returns generic text AND debug-logs the full error", () => {
    const stderrChunks: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      stderrChunks.push(args.map((a) => String(a)).join(" "));
    };
    let surfaced: string;
    try {
      surfaced = surfaceGenericError("store memory", new Error("boom: SECRET=hunter2"));
    } finally {
      console.error = origErr;
    }
    // Surfaced message is generic (no SECRET, no stack).
    expect(surfaced).not.toContain("SECRET");
    expect(surfaced).not.toContain("hunter2");
    expect(surfaced).not.toMatch(/at\s+\w+\s+\(/);
    expect(surfaced.length).toBeGreaterThan(0);
    // Debug log contains the full error.
    const debug = stderrChunks.join("\n");
    expect(debug).toContain("SECRET");
    expect(debug).toContain("hunter2");
  });

  test("injected backend throw: generic surfaced message + full error in debug log", async () => {
    const stderrChunks: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      stderrChunks.push(args.map((a) => String(a)).join(" "));
    };
    let result: { isError: boolean; text: string };
    try {
      const db = throwingDb();
      result = await handleStoreMemory(db, {
        type: "solution",
        title: "t",
        content: "c",
        tags: [],
        importance: 0.5,
      });
    } finally {
      console.error = origErr;
    }
    // Surfaced message is generic.
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("SECRET");
    expect(result.text).not.toContain("hunter2");
    // Full error is in the debug log.
    const debug = stderrChunks.join("\n");
    expect(debug).toContain("SECRET");
    expect(debug).toContain("hunter2");
  });
});
