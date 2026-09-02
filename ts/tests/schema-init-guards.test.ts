/**
 * REGRESSION: schema-init helper predicates and the Bolt double-init guard.
 *
 * Guards against regressing the behaviors fixed for the FalkorDB /
 * FalkorDBLite and Memgraph/Neo4j (Bolt) backends after the 0.14.0 merge.
 * These are pure/unit tests that run WITHOUT a live server:
 *
 *  - `isBenignSchemaError` / `isAlreadyExistsError`: the query/schema layer
 *    must NOT treat genuine errors as benign "already exists" duplicates, and
 *    MUST treat idempotent DDL duplicates as benign.
 *  - `isOperationalNodeRow` / `collectIndexedRangeProps` /
 *    `operationalMemoryConstraintPresent`: the introspection used to skip DDL
 *    on an existing store must classify rows correctly.
 *  - The Bolt `_schemaInitialized` guard must make a second
 *    `initializeSchema()` a no-op without re-issuing DDL.
 */

import { describe, test, expect } from "bun:test";

import {
  isBenignSchemaError,
  isAlreadyExistsError,
  isUnsupportedProcedureError,
  isOperationalNodeRow,
  collectIndexedRangeProps,
  operationalMemoryConstraintPresent,
} from "../src/backends/falkordb-shared.js";
import {
  isBenignSchemaError as boltIsBenignSchemaError,
  BaseBoltBackend,
} from "../src/backends/bolt-shared.js";
import { DatabaseConnectionError } from "../src/errors.js";

describe("isBenignSchemaError (falkordb-shared)", () => {
  test("true for 'already indexed' duplicates", () => {
    expect(isBenignSchemaError(new Error("Attribute 'id' is already indexed"))).toBe(true);
    expect(isBenignSchemaError("Attribute 'type' is already indexed")).toBe(true);
  });

  test("true for 'already exists' duplicates", () => {
    expect(isBenignSchemaError(new Error("Constraint already exists"))).toBe(true);
  });

  test("false for genuine query failures", () => {
    expect(isBenignSchemaError(new Error("Syntax error at line 1"))).toBe(false);
    expect(isBenignSchemaError(new Error("Connection refused"))).toBe(false);
  });

  test("true when the error string is a wrapped 'Query execution failed: ... already indexed'", () => {
    // executeQuery wraps the driver error in a DatabaseConnectionError whose
    // message still contains the benign marker.
    const wrapped = new DatabaseConnectionError(
      "Query execution failed: Error: Attribute 'id' is already indexed"
    );
    expect(isBenignSchemaError(wrapped)).toBe(true);
  });
});

describe("isBenignSchemaError (bolt-shared)", () => {
  test("true for 'already indexed' + 'Equivalent index' duplicates", () => {
    expect(boltIsBenignSchemaError(new Error("Attribute 'x' is already indexed"))).toBe(true);
    expect(boltIsBenignSchemaError(new Error("An equivalent index already exists"))).toBe(true);
  });

  test("false for genuine failures", () => {
    expect(boltIsBenignSchemaError(new Error("boom"))).toBe(false);
  });
});

describe("isAlreadyExistsError", () => {
  test("true for 'already indexed' / 'already exists'", () => {
    expect(isAlreadyExistsError(new Error("already indexed"))).toBe(true);
    expect(isAlreadyExistsError(new Error("already exists"))).toBe(true);
  });

  test("false for unrelated errors", () => {
    expect(isAlreadyExistsError(new Error("missing supporting exact-match index"))).toBe(false);
    expect(isAlreadyExistsError(new Error("Invalid constraint command"))).toBe(false);
  });
});

describe("isUnsupportedProcedureError", () => {
  test("true for 'Unknown procedure'", () => {
    expect(isUnsupportedProcedureError(new Error("Unknown procedure `db.indexes`"))).toBe(true);
  });

  test("true for 'Procedure not found'", () => {
    expect(isUnsupportedProcedureError("Procedure not found: db.constraints")).toBe(true);
  });

  test("false for connection, authorization, and timeout errors", () => {
    expect(isUnsupportedProcedureError(new Error("Connection refused"))).toBe(false);
    expect(isUnsupportedProcedureError(new Error("Permission denied"))).toBe(false);
    expect(isUnsupportedProcedureError(new Error("Query timed out"))).toBe(false);
  });

  test("false for benign already-exists duplicates", () => {
    expect(isUnsupportedProcedureError(new Error("Attribute 'id' is already indexed"))).toBe(false);
  });
});

describe("isOperationalNodeRow", () => {
  test("true for an operational Memory NODE row", () => {
    expect(
      isOperationalNodeRow({
        label: "Memory",
        entitytype: "NODE",
        status: "OPERATIONAL",
      })
    ).toBe(true);
  });

  test("true tolerates 'entityType' spelling", () => {
    expect(
      isOperationalNodeRow({
        label: "Memory",
        entityType: "node",
        status: "operational",
      })
    ).toBe(true);
  });

  test("false for non-Memory label", () => {
    expect(
      isOperationalNodeRow({ label: "Entity", entitytype: "NODE", status: "OPERATIONAL" })
    ).toBe(false);
  });

  test("false for non-OPERATIONAL status", () => {
    expect(
      isOperationalNodeRow({ label: "Memory", entitytype: "NODE", status: "PENDING" })
    ).toBe(false);
  });

  test("false for non-NODE entity type (e.g. relationship index)", () => {
    expect(
      isOperationalNodeRow({ label: "Memory", entitytype: "RELATIONSHIP", status: "OPERATIONAL" })
    ).toBe(false);
  });
});

describe("collectIndexedRangeProps", () => {
  test("collects only RANGE properties from the types map", () => {
    const row = {
      properties: ["id", "title"],
      types: { id: ["RANGE"], title: ["FULLTEXT"] },
    };
    expect(collectIndexedRangeProps(row)).toEqual(["id"]);
  });

  test("accepts RANGE_VALUE kinds", () => {
    const row = {
      properties: ["id"],
      types: { id: ["RANGE_VALUE"] },
    };
    expect(collectIndexedRangeProps(row)).toEqual(["id"]);
  });

  test("falls back to the properties list when types is absent", () => {
    const row = { properties: ["id", "type"] };
    expect(collectIndexedRangeProps(row)).toEqual(["id", "type"]);
  });

  test("returns empty array when no properties", () => {
    expect(collectIndexedRangeProps({ properties: [] })).toEqual([]);
  });
});

describe("operationalMemoryConstraintPresent", () => {
  test("true when an operational UNIQUE constraint on Memory.id exists", () => {
    const rows = [
      { type: "UNIQUE", label: "Memory", entitytype: "NODE", status: "OPERATIONAL", properties: ["id"] },
    ];
    expect(operationalMemoryConstraintPresent(rows)).toBe(true);
  });

  test("false when the constraint is not UNIQUE", () => {
    const rows = [
      { type: "EXISTS", label: "Memory", entitytype: "NODE", status: "OPERATIONAL", properties: ["id"] },
    ];
    expect(operationalMemoryConstraintPresent(rows)).toBe(false);
  });

  test("false when the constraint is not on the id property", () => {
    const rows = [
      { type: "UNIQUE", label: "Memory", entitytype: "NODE", status: "OPERATIONAL", properties: ["name"] },
    ];
    expect(operationalMemoryConstraintPresent(rows)).toBe(false);
  });

  test("false when status is not OPERATIONAL", () => {
    const rows = [
      { type: "UNIQUE", label: "Memory", entitytype: "NODE", status: "PENDING", properties: ["id"] },
    ];
    expect(operationalMemoryConstraintPresent(rows)).toBe(false);
  });

  test("false on empty rows", () => {
    expect(operationalMemoryConstraintPresent([])).toBe(false);
  });
});

describe("Bolt schema double-init guard", () => {
  // A minimal concrete backend that exposes a counting executeQuery so we can
  // assert a second initializeSchema() does not re-issue any DDL.
  class CountingBoltBackend extends BaseBoltBackend {
    _display_name = "TestBolt";
    executedQueries: string[] = [];

    constructor() {
      super("bolt://localhost:7687");
    }

    async connect(): Promise<boolean> {
      return true;
    }
    async healthCheck() {
      return { connected: true, backend_type: "testbolt", db_path: "x" };
    }
    backendName(): string {
      return "testbolt";
    }

    async executeQuery(query: string): Promise<Record<string, unknown>[]> {
      this.executedQueries.push(query);
      // The non-duplicate path of initializeSchema() would persist indexes, but
      // this mock just records the calls.
      return [{ ok: true as unknown }];
    }
  }

  test("second initializeSchema() does not re-issue DDL", async () => {
    const bk = new CountingBoltBackend();
    // First run issues the index DDL and sets the guard.
    await bk.initializeSchema();
    const firstCount = bk.executedQueries.length;
    expect(firstCount).toBeGreaterThan(0);

    // Capture noise: the second call must be a silent no-op.
    const errChunks: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => errChunks.push(a.map(String).join(" "));
    let secondCount: number;
    try {
      await bk.initializeSchema();
      secondCount = bk.executedQueries.length;
    } finally {
      console.error = origErr;
    }

    expect(secondCount).toBe(firstCount);
    expect(errChunks.join("\n")).not.toContain("Query execution failed");
  });
});