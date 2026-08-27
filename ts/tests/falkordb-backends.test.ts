/**
 * Tests for FalkorDB and Memgraph backend classes.
 *
 * These tests verify the class structure, configuration, and error handling
 * without requiring a running FalkorDB or Memgraph server. Connection tests
 * are skipped when no server is available.
 */

import { describe, test, expect } from "bun:test";
import { FalkorDBBackend } from "../src/backends/falkordb.js";
import { MemgraphBackend } from "../src/backends/memgraph.js";
import { BaseFalkorDBBackend } from "../src/backends/falkordb-shared.js";
import { BaseBoltBackend } from "../src/backends/bolt-shared.js";
import { BackendFactory } from "../src/backends/factory.js";
import { DatabaseConnectionError } from "../src/errors.js";

describe("FalkorDBBackend", () => {
  test("creates instance with default config", () => {
    const backend = new FalkorDBBackend();
    expect(backend.backendName()).toBe("falkordb");
    expect(backend._display_name).toBe("FalkorDB");
    expect(backend.graphName).toBe("memorygraph");
    expect(backend.host).toBeDefined();
    expect(backend.port).toBeGreaterThan(0);
  });

  test("creates instance with custom options", () => {
    const backend = new FalkorDBBackend({
      host: "remote.example.com",
      port: 7689,
      password: "secret",
      graphName: "custom-graph",
    });
    expect(backend.host).toBe("remote.example.com");
    expect(backend.port).toBe(7689);
    expect(backend.password).toBe("secret");
    expect(backend.graphName).toBe("custom-graph");
  });

  test("is a subclass of BaseFalkorDBBackend", () => {
    const backend = new FalkorDBBackend();
    expect(backend).toBeInstanceOf(BaseFalkorDBBackend);
  });

  test("supports Cypher", () => {
    const backend = new FalkorDBBackend();
    expect(backend.isCypherCapable()).toBe(true);
    expect(backend.supportsFulltextSearch()).toBe(true);
    expect(backend.supportsTransactions()).toBe(true);
  });

  test("healthCheck returns disconnected when not connected", async () => {
    const backend = new FalkorDBBackend();
    const health = await backend.healthCheck();
    expect(health.connected).toBe(false);
    expect(health.backend_type).toBe("falkordb");
  });

  test("disconnect is safe when never connected", async () => {
    const backend = new FalkorDBBackend();
    await expect(backend.disconnect()).resolves.toBeUndefined();
  });

  test("factory createFalkorDB throws on connection failure", async () => {
    const backend = new FalkorDBBackend({ host: "nonexistent", port: 1 });
    await expect(backend.connect()).rejects.toThrow(DatabaseConnectionError);
  });
});

describe("MemgraphBackend", () => {
  test("creates instance with default config", () => {
    const backend = new MemgraphBackend();
    expect(backend.backendName()).toBe("memgraph");
    expect(backend._display_name).toBe("Memgraph");
    expect(backend.uri).toBeDefined();
    expect(backend.uri).toMatch(/^bolt:\/\//);
  });

  test("creates instance with custom options", () => {
    const backend = new MemgraphBackend({
      uri: "bolt://remote.example.com:7688",
      username: "memgraph",
      password: "password123",
    });
    expect(backend.uri).toBe("bolt://remote.example.com:7688");
    expect(backend.username).toBe("memgraph");
    expect(backend.password).toBe("password123");
  });

  test("is a subclass of BaseBoltBackend", () => {
    const backend = new MemgraphBackend();
    expect(backend).toBeInstanceOf(BaseBoltBackend);
  });

  test("supports Cypher", () => {
    const backend = new MemgraphBackend();
    expect(backend.isCypherCapable()).toBe(true);
    expect(backend.supportsFulltextSearch()).toBe(true);
    expect(backend.supportsTransactions()).toBe(true);
  });

  test("healthCheck returns disconnected when not connected", async () => {
    const backend = new MemgraphBackend();
    const health = await backend.healthCheck();
    expect(health.connected).toBe(false);
    expect(health.backend_type).toBe("memgraph");
  });

  test("disconnect is safe when never connected", async () => {
    const backend = new MemgraphBackend();
    await expect(backend.disconnect()).resolves.toBeUndefined();
  });

  test("connect throws on unreachable server", async () => {
    const backend = new MemgraphBackend({ uri: "bolt://nonexistent:7687" });
    await expect(backend.connect()).rejects.toThrow(DatabaseConnectionError);
  });
});

describe("BackendFactory integration", () => {
  test("factory registers falkordb in backend names", async () => {
    // The factory should accept "falkordb" as a valid backend type.
    // It will try to connect, but we just verify the dispatch doesn't
    // throw an "unknown backend" error (connection errors are expected
    // without a running server). The promise MUST be awaited: a floating
    // connect rejects seconds later and the unhandled rejection fails
    // whatever unrelated test is running at that moment
    // (VAL-REVIEW-026).
    await BackendFactory.createBackendByType("falkordb").catch((err) => {
      expect(String(err)).not.toContain("Unknown backend");
    });
  });

  test("factory registers memgraph in backend names", async () => {
    await BackendFactory.createBackendByType("memgraph").catch((err) => {
      expect(String(err)).not.toContain("Unknown backend");
    });
  });

  test("isBackendConfigured returns true for falkordblite and sqlite", () => {
    expect(BackendFactory.isBackendConfigured("falkordblite")).toBe(true);
    expect(BackendFactory.isBackendConfigured("sqlite")).toBe(true);
  });

  test("isBackendConfigured returns false for unconfigured neo4j", () => {
    expect(BackendFactory.isBackendConfigured("neo4j")).toBe(false);
  });
});
