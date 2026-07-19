/**
 * Centralized error handling for CLI tool handlers and the SDK/integration
 * boundary.
 *
 * Two layers:
 *
 * 1. `handleToolErrors` — the inner tool-layer wrapper. Catches known
 *    MemoryError subtypes and returns a structured { isError, text } with a
 *    curated, user-facing message. For unexpected (non-MemoryError) throws,
 *    it debug-logs the full error and re-throws so the outer boundary can
 *    surface a generic message (SEC-5: no sensitive data / raw stack at the
 *    surfaced boundary).
 *
 * 2. `neverThrowBoundary` — the outer SDK/integration wrapper (above
 *    handleToolErrors). Guarantees NO throw ever escapes to the caller
 *    (pickle-rick). Catches everything handleToolErrors re-throws (plus any
 *    sync throws, non-Error throws, or bugs in handleToolErrors itself),
 *    debug-logs the full error, and returns a generic structured error.
 *
 * `surfaceGenericError` is the same boundary for the CLI's top-level catch.
 */

import {
  MemoryError,
  MemoryNotFoundError,
  RelationshipError,
  ValidationError,
} from "../errors.js";

/**
 * Debug-log the full error (message + stack) so operators can diagnose
 * failures without that data ever being surfaced to the caller. Tagged with
 * a `[memorygraph-debug]` prefix so consumers can identify and grep it.
 *
 * SEC-5: the full error lives HERE (in the debug log), never in the surfaced
 * message.
 */
export function debugLogError(operationName: string, err: unknown): void {
  // `err.stack` already includes `${err.name}: ${err.message}\n    at ...`,
  // so use it directly to avoid duplicating the message in the debug log.
  const fullErr =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err);
  console.error(`[memorygraph-debug] ${operationName} failed: ${fullErr}`);
}

/**
 * Surface a generic error message to the caller AND debug-log the full error.
 * Returns the generic text. Use at any integration boundary where a throw
 * must not escape (e.g. the CLI top-level catch).
 *
 * SEC-5: the returned text contains no sensitive data and no raw stack.
 */
export function surfaceGenericError(operationName: string, err: unknown): string {
  debugLogError(operationName, err);
  return `An internal error occurred while performing ${operationName}. See debug log for details.`;
}

/**
 * Inner tool-layer wrapper. Catches known MemoryError subtypes and returns
 * a structured result with a curated message. Unexpected (non-MemoryError)
 * throws are debug-logged and RE-THROWN so the outer neverThrowBoundary can
 * surface a generic message (SEC-5).
 */
export function handleToolErrors<T extends (...args: any[]) => Promise<any>>(
  operationName: string,
  fn: T
): (...args: Parameters<T>) => Promise<{ isError: boolean; text: string }> {
  return async (...args: Parameters<T>) => {
    try {
      const result = await fn(...args);
      // If the handler already returned a structured result, pass it through
      if (result && typeof result === "object" && "text" in result && "isError" in result) {
        return result;
      }
      return { isError: false, text: result };
    } catch (err) {
      // Curated, user-facing messages for known error types — these are
      // intentional and contain no raw stack / sensitive data.
      if (err instanceof MemoryNotFoundError) {
        return { isError: true, text: String(err) };
      }
      if (err instanceof RelationshipError) {
        return { isError: true, text: `Relationship error: ${err}` };
      }
      if (err instanceof ValidationError) {
        return { isError: true, text: `Validation error: ${err}` };
      }
      if (err instanceof MemoryError) {
        return { isError: true, text: String(err) };
      }
      // Unexpected throw — debug-log the full error, then re-throw so the
      // outer neverThrowBoundary surfaces a generic message (SEC-5).
      debugLogError(operationName, err);
      throw err;
    }
  };
}

/**
 * Outer SDK/integration boundary wrapper. Guarantees the wrapped function
 * NEVER throws to the caller — every throw is caught, the full error is
 * debug-logged, and a generic structured error is returned.
 *
 * Apply this AROUND handleToolErrors-wrapped handlers (or any SDK entry
 * point) so a backend throw can never escape to pickle-rick.
 *
 * SEC-5: the surfaced text is generic (no sensitive data / raw stack); the
 * full error lives in the debug log.
 */
export function neverThrowBoundary<T extends (...args: any[]) => Promise<any>>(
  operationName: string,
  fn: T
): (...args: Parameters<T>) => Promise<{ isError: boolean; text: string }> {
  return async (...args: Parameters<T>) => {
    try {
      const result = await fn(...args);
      if (result && typeof result === "object" && "text" in result && "isError" in result) {
        return result;
      }
      return { isError: false, text: result };
    } catch (err) {
      // Final safety net — no throw escapes. Generic surfaced message,
      // full error in the debug log.
      const text = surfaceGenericError(operationName, err);
      return { isError: true, text };
    }
  };
}
