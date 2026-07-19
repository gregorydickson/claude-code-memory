/**
 * Bounded query timeout tests (VAL-FAILOPEN-003, 004, 007).
 *
 * Verifies:
 *  - errors.ts exports a typed TimeoutError class
 *  - config.ts exposes a QUERY_TIMEOUT getter reading MEMORYGRAPH_QUERY_TIMEOUT
 *    (default 5000ms)
 *  - BaseFalkorDBBackend.executeQuery and BaseBoltBackend.executeQuery enforce
 *    a bounded timeout: when MEMORYGRAPH_QUERY_TIMEOUT=1 and the underlying
 *    driver call never resolves, a TimeoutError is raised at the executeQuery
 *    choke point (no hang, no unhandled exception).
 */

import { describe, test, expect, afterEach } from "bun:test";

import { TimeoutError } from "../src/errors.js";
import { Config } from "../src/config.js";
import { FalkorDBLiteBackend } from "../src/backends/falkordblite.js";
import { MemgraphBackend } from "../src/backends/memgraph.js";

const STASH_TIMEOUT = process.env.MEMORYGRAPH_QUERY_TIMEOUT;

afterEach(() => {
  if (STASH_TIMEOUT === undefined) delete process.env.MEMORYGRAPH_QUERY_TIMEOUT;
  else process.env.MEMORYGRAPH_QUERY_TIMEOUT = STASH_TIMEOUT;
});

describe("VAL-FAILOPEN-003: TimeoutError type exists in errors.ts", () => {
  test("TimeoutError is a class extending Error", () => {
    expect(typeof TimeoutError).toBe("function");
    const err = new TimeoutError("query timed out");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.name).toBe("TimeoutError");
    expect(err.message).toContain("query timed out");
  });
});

describe("VAL-FAILOPEN-007: config.ts QUERY_TIMEOUT getter", () => {
  test("reads MEMORYGRAPH_QUERY_TIMEOUT from env", () => {
    process.env.MEMORYGRAPH_QUERY_TIMEOUT = "1234";
    expect(Config.QUERY_TIMEOUT).toBe(1234);
  });

  test("falls back to a sane default (5000ms) when env unset", () => {
    delete process.env.MEMORYGRAPH_QUERY_TIMEOUT;
    const v = Config.QUERY_TIMEOUT;
    expect(v).toBe(5000);
  });

  test("falls back to default when env value is non-numeric", () => {
    process.env.MEMORYGRAPH_QUERY_TIMEOUT = "not-a-number";
    expect(Config.QUERY_TIMEOUT).toBe(5000);
  });
});

describe("VAL-FAILOPEN-004: bounded query timeout fires at executeQuery", () => {
  test("BaseFalkorDBBackend.executeQuery raises TimeoutError on a hanging query (no hang)", async () => {
    process.env.MEMORYGRAPH_QUERY_TIMEOUT = "1";
    const backend = new FalkorDBLiteBackend();
    // Bypass connect(): inject a mock graph whose query never resolves.
    (backend as any)._connected = true;
    (backend as any).graph = {
      query: () => new Promise(() => {}), // never resolves
    };

    const start = Date.now();
    await expect(
      backend.executeQuery("MATCH (m:Memory) RETURN count(m) AS c", {}, false)
    ).rejects.toThrow(TimeoutError);
    const elapsed = Date.now() - start;

    // Should fire quickly (well under 1000ms; the timeout is 1ms + scheduling).
    expect(elapsed).toBeLessThan(1000);
  });

  test("BaseBoltBackend.executeQuery raises TimeoutError on a hanging query (no hang)", async () => {
    process.env.MEMORYGRAPH_QUERY_TIMEOUT = "1";
    const backend = new MemgraphBackend({ uri: "bolt://placeholder:7687" });
    (backend as any)._connected = true;
    // Mock driver + session where session.run never resolves.
    (backend as any).driver = {
      session: () => ({
        run: () => new Promise(() => {}),
        close: async () => {},
      }),
    };

    const start = Date.now();
    await expect(
      backend.executeQuery("MATCH (m:Memory) RETURN count(m) AS c", {}, false)
    ).rejects.toThrow(TimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  test("BaseFalkorDBBackend.executeQuery still resolves normally when the query returns in time", async () => {
    // Set a generous timeout so the happy path is unaffected.
    process.env.MEMORYGRAPH_QUERY_TIMEOUT = "5000";
    const backend = new FalkorDBLiteBackend();
    (backend as any)._connected = true;
    (backend as any).graph = {
      query: async (_q: string, _opts: unknown) => ({
        headers: [],
        data: [],
        metadata: [],
      }),
    };

    const result = await backend.executeQuery("RETURN 1", {}, false);
    expect(Array.isArray(result)).toBe(true);
  });
});
