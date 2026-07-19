/**
 * FalkorDB (client-server) backend implementation.
 *
 * Connects to a running FalkorDB server via the Redis protocol using the
 * `falkordb` npm package. Shares all Cypher query logic with FalkorDBLite
 * via BaseFalkorDBBackend; only connection setup differs.
 */

import { Config } from "../config.ts";
import { DatabaseConnectionError } from "../errors.ts";
import { BaseFalkorDBBackend } from "./falkordb-shared.ts";
import type { HealthCheckResult } from "./index.ts";

export class FalkorDBBackend extends BaseFalkorDBBackend {
  _display_name = "FalkorDB";

  host: string;
  port: number;
  password?: string;

  constructor(opts?: { host?: string; port?: number; password?: string; graphName?: string }) {
    super(opts?.graphName ?? "memorygraph");
    this.host = opts?.host ?? Config.FALKORDB_HOST;
    this.port = opts?.port ?? Config.FALKORDB_PORT;
    this.password = opts?.password ?? Config.FALKORDB_PASSWORD;
  }

  async connect(): Promise<boolean> {
    try {
      let FalkorDB: any;
      try {
        const mod = await import("falkordb");
        FalkorDB = mod.FalkorDB ?? mod.default;
      } catch {
        throw new DatabaseConnectionError(
          "falkordb package is required for the FalkorDB client-server backend. " +
            "Install with: bun add falkordb\n" +
            "Alternatively, use --backend falkordblite for embedded storage."
        );
      }

      const url = `falkor://${this.host}:${this.port}`;

      const options: Record<string, unknown> = { url };
      if (this.password) {
        options["password"] = this.password;
      }

      this.client = await FalkorDB.connect(options);
      this.graph = this.client.selectGraph(this.graphName);
      this._connected = true;

      console.log(`Successfully connected to FalkorDB at ${this.host}:${this.port}`);
      return true;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to connect to FalkorDB: ${err}`);
      throw new DatabaseConnectionError(
        `Failed to connect to FalkorDB at ${this.host}:${this.port}: ${err}\n` +
          "Ensure a FalkorDB server is running. Use --backend falkordblite for embedded storage."
      );
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const healthInfo: HealthCheckResult = {
      connected: this._connected,
      backend_type: "falkordb",
      host: this.host,
      port: this.port,
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
    return "falkordb";
  }

  static async create(
    opts?: { host?: string; port?: number; password?: string; graphName?: string }
  ): Promise<FalkorDBBackend> {
    const backend = new FalkorDBBackend(opts);
    await backend.connect();
    return backend;
  }
}
