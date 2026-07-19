/**
 * Tier 3 #20 — observe-only guard tests (VAL-TIER3-006 / VAL-TIER3-007).
 *
 * Asserts that in auto mode MemoryGraph is observe-only: it may record/query
 * only, and NO blocking path (Done-flip, gate, or commit) is reachable from
 * auto mode.
 */
import { describe, test, expect, afterEach } from "bun:test";

import {
  assertAutoModeSafe,
  isAutoMode,
  isAutoModePermitted,
  isBlockingOperation,
  isObserveOnlyOperation,
  getBlockingOperations,
  getObserveOnlyOperations,
  ObserveOnlyViolation,
} from "../src/observe-only-guard.ts";

afterEach(() => {
  // Reset auto mode between tests so ordering doesn't matter.
  delete process.env["MEMORYGRAPH_AUTO_MODE"];
});

describe("VAL-TIER3-006: observe-only guard module exists and classifies ops", () => {
  test("auto mode is OFF by default", () => {
    delete process.env["MEMORYGRAPH_AUTO_MODE"];
    expect(isAutoMode()).toBe(false);
  });

  test("auto mode turns ON when MEMORYGRAPH_AUTO_MODE=1", () => {
    process.env["MEMORYGRAPH_AUTO_MODE"] = "1";
    expect(isAutoMode()).toBe(true);
  });

  test("auto mode turns ON when MEMORYGRAPH_AUTO_MODE=true (case-insensitive)", () => {
    process.env["MEMORYGRAPH_AUTO_MODE"] = "TRUE";
    expect(isAutoMode()).toBe(true);
  });

  test("auto mode stays OFF for unrelated env values", () => {
    process.env["MEMORYGRAPH_AUTO_MODE"] = "no";
    expect(isAutoMode()).toBe(false);
  });

  test("blocking operations are classified as blocking", () => {
    for (const op of getBlockingOperations()) {
      expect(isBlockingOperation(op)).toBe(true);
    }
  });

  test("observe-only operations are classified as observe-only", () => {
    for (const op of getObserveOnlyOperations()) {
      expect(isObserveOnlyOperation(op)).toBe(true);
    }
  });

  test("no operation is in BOTH the blocking and observe-only sets", () => {
    const blocking = new Set(getBlockingOperations());
    const allowed = new Set(getObserveOnlyOperations());
    for (const op of blocking) {
      expect(allowed.has(op)).toBe(false);
    }
    for (const op of allowed) {
      expect(blocking.has(op)).toBe(false);
    }
  });

  test("guard module exports a typed ObserveOnlyViolation error", () => {
    const err = new ObserveOnlyViolation("block_done_flip");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ObserveOnlyViolation");
    expect(err.operation).toBe("block_done_flip");
    expect(err.message).toContain("Observe-only violation");
    expect(err.message).toContain("block_done_flip");
  });
});

describe("VAL-TIER3-007: no blocking path is reachable from auto mode", () => {
  test("every blocking operation is REJECTED by assertAutoModeSafe in auto mode", () => {
    process.env["MEMORYGRAPH_AUTO_MODE"] = "1";
    for (const op of getBlockingOperations()) {
      expect(() => assertAutoModeSafe(op)).toThrow(ObserveOnlyViolation);
    }
  });

  test("every blocking operation is NOT permitted in auto mode (boolean API)", () => {
    process.env["MEMORYGRAPH_AUTO_MODE"] = "1";
    for (const op of getBlockingOperations()) {
      expect(isAutoModePermitted(op)).toBe(false);
    }
  });

  test("every CLI command (observe-only op) is PERMITTED in auto mode", () => {
    process.env["MEMORYGRAPH_AUTO_MODE"] = "1";
    for (const op of getObserveOnlyOperations()) {
      expect(() => assertAutoModeSafe(op)).not.toThrow();
      expect(isAutoModePermitted(op)).toBe(true);
    }
  });

  test("the full v1.0 frozen CLI command surface is observe-only (no blocking command exists)", () => {
    // The authoritative CLI command set from CONTRACT.md / cli.ts main() switch.
    // Every one of these MUST be an observe-only operation and MUST NOT be a
    // blocking operation. This is the core #20 invariant: MemoryGraph exposes
    // NO command that can block a Done-flip, gate, or commit.
    const cliCommands = [
      "store", "get", "update", "delete", "rm", "search", "recall",
      "related", "link", "stats", "activity", "as-of", "history",
      "changes", "context-search", "contextual-search", "entities",
      "patterns", "context", "visualize", "similarity", "learning",
      "gaps", "briefing", "predict", "warn", "outcome", "capture",
      "analyze-project", "workflow", "export", "import", "migrate",
      "health", "config",
    ];
    for (const cmd of cliCommands) {
      expect(isObserveOnlyOperation(cmd)).toBe(true);
      expect(isBlockingOperation(cmd)).toBe(false);
    }
    // The guard's own observe-only list must match the CLI surface exactly
    // (same 35 entries including the `rm` alias).
    expect(getObserveOnlyOperations().length).toBe(cliCommands.length);
  });

  test("blocking operations are rejected even when auto mode is toggled at runtime", () => {
    delete process.env["MEMORYGRAPH_AUTO_MODE"];
    expect(() => assertAutoModeSafe("block_done_flip")).not.toThrow();
    process.env["MEMORYGRAPH_AUTO_MODE"] = "1";
    expect(() => assertAutoModeSafe("block_done_flip")).toThrow(ObserveOnlyViolation);
    delete process.env["MEMORYGRAPH_AUTO_MODE"];
    expect(() => assertAutoModeSafe("block_done_flip")).not.toThrow();
  });

  test("the guard rejects the canonical pipeline-blocking operations by name", () => {
    // These are the exact operations a pipeline orchestrator might expose
    // that would let MemoryGraph block the agent. None of them are
    // reachable in auto mode.
    process.env["MEMORYGRAPH_AUTO_MODE"] = "1";
    const canonicalBlocking = [
      "block_done_flip",
      "gate_pipeline",
      "commit_on_behalf",
      "halt_agent",
      "fail_pipeline",
      "block_commit",
      "block_gate",
      "block_done",
    ];
    for (const op of canonicalBlocking) {
      expect(isBlockingOperation(op)).toBe(true);
      expect(() => assertAutoModeSafe(op)).toThrow(ObserveOnlyViolation);
    }
  });

  test("assertAutoModeSafe is a no-op in manual mode (auto OFF)", () => {
    delete process.env["MEMORYGRAPH_AUTO_MODE"];
    // Even a blocking operation is allowed when auto mode is OFF (manual use).
    for (const op of getBlockingOperations()) {
      expect(() => assertAutoModeSafe(op)).not.toThrow();
    }
    for (const op of getObserveOnlyOperations()) {
      expect(() => assertAutoModeSafe(op)).not.toThrow();
    }
  });

  test("unknown operations are not classified as blocking (fail-open, not fail-closed on novelty)", () => {
    // An unknown operation is not in the blocking set, so it is permitted.
    // This is intentional: the guard's deny-list is the blocking set; anything
    // NOT on the deny-list is allowed. The guard's JOB is to keep the
    // blocking set exhaustive of all pipeline-blocking effects, not to
    // require every new operation to be allow-listed.
    expect(isBlockingOperation("some_new_command")).toBe(false);
    process.env["MEMORYGRAPH_AUTO_MODE"] = "1";
    expect(() => assertAutoModeSafe("some_new_command")).not.toThrow();
  });
});
