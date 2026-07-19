/**
 * Observe-only guard for auto mode — Tier 3 #20 (VAL-TIER3-006 / VAL-TIER3-007).
 *
 * When MemoryGraph is integrated into an autonomous agent pipeline (e.g.
 * pickle-rick) in "auto mode", it MUST be observe-only: it may record
 * memories and query the graph, but it MUST NEVER be on a code path that
 * can block a Done-flip, gate, or commit on behalf of the agent.
 *
 * This module is the single enforcement point for that invariant. It
 * classifies every operation MemoryGraph can perform into one of two sets:
 *
 *   - OBSERVE_ONLY_OPERATIONS: record / query operations (every CLI command
 *     in the v1.0 frozen surface — store, search, recall, link, etc.). These
 *     are the ONLY operations permitted when auto mode is active.
 *   - BLOCKING_OPERATIONS: operations that, if MemoryGraph exposed them,
 *     would let it block the agent's pipeline progress. MemoryGraph does
 *     NOT expose any of these today; this set exists so the guard can
 *     reject them if they are ever introduced.
 *
 * `assertAutoModeSafe(op)` is the gate: it throws an `ObserveOnlyViolation`
 * if a blocking operation is requested while auto mode is active. The guard
 * test (tests/observe-only-guard.test.ts) sweeps the entire CLI command
 * surface and the blocking set to assert no blocking path is reachable.
 *
 * Auto mode is opt-in via the `MEMORYGRAPH_AUTO_MODE` env var (set to "1" or
 * "true"). When auto mode is OFF, the guard is a no-op (all operations
 * allowed) so interactive / manual use is unaffected.
 */

// ---------------------------------------------------------------------------
// Operation classifications
// ---------------------------------------------------------------------------

/**
 * The set of operations that would let MemoryGraph BLOCK the agent's
 * pipeline progress. MemoryGraph does NOT expose any of these today; the
 * set is the guard's deny-list. If a future operation maps to one of these,
 * `assertAutoModeSafe` will reject it in auto mode.
 *
 * The names are deliberately pipeline-semantic (not MemoryGraph-internal):
 * they describe the EFFECT on the calling agent, not a MemoryGraph command.
 */
const BLOCKING_OPERATIONS: ReadonlySet<string> = new Set([
  "block_done_flip", // signal the agent NOT to mark a task Done
  "gate_pipeline", // gate/halt the pipeline pending MemoryGraph approval
  "commit_on_behalf", // commit to git on behalf of the agent
  "halt_agent", // halt/stop the agent
  "fail_pipeline", // force-fail the pipeline
  "block_commit", // block a git commit
  "block_gate", // block a gate check
  "block_done", // block a Done-flip (alias of block_done_flip)
]);

/**
 * The full v1.0 frozen CLI command surface (see CONTRACT.md). Every one of
 * these is a record/query operation — none can block a Done-flip, gate, or
 * commit. These are the ONLY operations permitted in auto mode.
 *
 * Sourced from the authoritative command list in `ts/src/cli.ts` main()
 * switch and CONTRACT.md §1. Kept in sync by the guard test, which
 * cross-checks this list against the CLI's own command set.
 */
const OBSERVE_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  "store",
  "get",
  "update",
  "delete",
  "rm",
  "search",
  "recall",
  "related",
  "link",
  "stats",
  "activity",
  "as-of",
  "history",
  "changes",
  "context-search",
  "contextual-search",
  "entities",
  "patterns",
  "context",
  "visualize",
  "similarity",
  "learning",
  "gaps",
  "briefing",
  "predict",
  "warn",
  "outcome",
  "capture",
  "analyze-project",
  "workflow",
  "export",
  "import",
  "migrate",
  "health",
  "config",
]);

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown by `assertAutoModeSafe` when a blocking operation is requested
 * while auto mode is active. This is the only error type the guard raises;
 * it is a programmer/integration error (a blocking path was wired into an
 * auto-mode call site), not a runtime data error.
 */
export class ObserveOnlyViolation extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(
      `Observe-only violation: operation '${operation}' is blocking and is ` +
        `forbidden in auto mode. MemoryGraph in auto mode may only record/query ` +
        `(store/get/update/delete/search/recall/related/link/...). It must NEVER ` +
        `block a Done-flip, gate, or commit on behalf of the agent. ` +
        `(see docs/planning/TIER3-SCOPE.md, Tier 3 #20)`
    );
    this.name = "ObserveOnlyViolation";
    this.operation = operation;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Whether auto (observe-only) mode is active. Reads the
 * `MEMORYGRAPH_AUTO_MODE` env var at call time so callers can toggle it
 * per-invocation. Defaults to OFF (manual/interactive mode).
 */
export function isAutoMode(): boolean {
  const v = process.env["MEMORYGRAPH_AUTO_MODE"];
  return v === "1" || v === "true" || v === "TRUE";
}

/**
 * True if `op` is a blocking operation (one that could block a Done-flip,
 * gate, or commit). These are NEVER permitted in auto mode.
 */
export function isBlockingOperation(op: string): boolean {
  return BLOCKING_OPERATIONS.has(op);
}

/**
 * True if `op` is an observe-only operation (a record/query CLI command).
 * These are the ONLY operations permitted in auto mode.
 */
export function isObserveOnlyOperation(op: string): boolean {
  return OBSERVE_ONLY_OPERATIONS.has(op);
}

/**
 * The canonical list of blocking operation names. Exposed for the guard
 * test so it can sweep the full deny-list without hardcoding it.
 */
export function getBlockingOperations(): string[] {
  return Array.from(BLOCKING_OPERATIONS);
}

/**
 * The canonical list of observe-only operation names (the v1.0 CLI command
 * surface). Exposed for the guard test so it can sweep the full allow-list
 * without hardcoding it.
 */
export function getObserveOnlyOperations(): string[] {
  return Array.from(OBSERVE_ONLY_OPERATIONS);
}

/**
 * The enforcement gate. Call this before dispatching `op` when MemoryGraph
 * is integrated into an agent pipeline. If auto mode is active AND `op` is
 * a blocking operation, throws `ObserveOnlyViolation`. Otherwise returns
 * void (no-op).
 *
 * In manual / interactive mode (auto mode OFF), this is always a no-op —
 * all operations are allowed.
 */
export function assertAutoModeSafe(op: string): void {
  if (isAutoMode() && isBlockingOperation(op)) {
    throw new ObserveOnlyViolation(op);
  }
}

/**
 * True if `op` is permitted in the current mode. Convenience wrapper around
 * `assertAutoModeSafe` for callers that prefer a boolean over a throw.
 */
export function isAutoModePermitted(op: string): boolean {
  if (!isAutoMode()) return true;
  return !isBlockingOperation(op);
}
