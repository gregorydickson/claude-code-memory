/**
 * FalkorDBLite backend implementation.
 *
 * FalkorDBLite is an embedded graph database with native Cypher support.
 * In the TypeScript/Bun port, we connect to a local FalkorDB instance
 * via the Redis protocol (FalkorDB runs on top of Redis).
 *
 * For truly embedded (zero-server) operation, a SQLite-based fallback
 * is available via the SQLite backend.
 */

import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { Config } from "../config.ts";
import { DatabaseConnectionError } from "../errors.ts";
import { BaseFalkorDBBackend } from "./falkordb-shared.ts";
import type { HealthCheckResult } from "./index.ts";

export class FalkorDBLiteBackend extends BaseFalkorDBBackend {
  _display_name = "FalkorDBLite";

  dbPath: string;

  constructor(dbPath?: string, graphName = "memorygraph") {
    super(graphName);
    this.dbPath = dbPath ?? Config.FALKORDBLITE_PATH;
    // Ensure directory exists
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  async connect(): Promise<boolean> {
    try {
      // Use falkordblite for embedded, zero-server operation
      let FalkorDB: any;
      try {
        const mod = await import("falkordblite");
        FalkorDB = mod.FalkorDB ?? mod.default;
      } catch {
        throw new DatabaseConnectionError(
          "falkordblite package is required for FalkorDBLite backend. " +
            "Install with: bun add falkordblite\n" +
            "Alternatively, use --backend sqlite for zero-server embedded storage."
        );
      }

      // FalkorDBLite opens an embedded redis-server with the FalkorDB module.
      // Pass a path for persistence between runs.
      this.client = await FalkorDB.open({ path: this.dbPath });

      this.graph = this.client.selectGraph(this.graphName);
      this._connected = true;

      console.log(`Successfully connected to FalkorDBLite at ${this.dbPath}`);
      return true;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to connect to FalkorDBLite: ${err}`);
      throw new DatabaseConnectionError(
        `Failed to connect to FalkorDBLite: ${err}\n` +
          "Alternatively, use --backend sqlite for zero-server embedded storage."
      );
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const healthInfo: HealthCheckResult = {
      connected: this._connected,
      backend_type: "falkordblite",
      db_path: this.dbPath,
      graph_name: this.graphName,
    };

    if (this._connected) {
      try {
        const countResult = await this.executeQuery(
          "MATCH (m:Memory) RETURN count(m) as count",
          {},
          false
        );
        if (countResult.length > 0) {
          healthInfo["statistics"] = {
            memory_count: countResult[0]["count"],
          };
        }
      } catch (err) {
        healthInfo["warning"] = String(err);
      }
    }

    return healthInfo;
  }

  backendName(): string {
    return "falkordblite";
  }

  static async create(
    dbPath?: string,
    graphName = "memorygraph"
  ): Promise<FalkorDBLiteBackend> {
    const backend = new FalkorDBLiteBackend(dbPath, graphName);
    await backend.connect();
    return backend;
  }
}
