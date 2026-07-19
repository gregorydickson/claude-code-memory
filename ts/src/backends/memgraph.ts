/**
 * Memgraph backend implementation.
 *
 * Connects to a Memgraph instance via the Bolt protocol using the
 * `neo4j-driver` npm package (Memgraph is Bolt-compatible). Shares
 * Cypher query logic with other Bolt-protocol backends via BaseBoltBackend.
 */

import { Config } from "../config.ts";
import { DatabaseConnectionError } from "../errors.ts";
import { BaseBoltBackend } from "./bolt-shared.ts";
import type { HealthCheckResult } from "./index.ts";

export class MemgraphBackend extends BaseBoltBackend {
  _display_name = "Memgraph";

  constructor(opts?: { uri?: string; username?: string; password?: string }) {
    const uri = opts?.uri ?? Config.MEMGRAPH_URI;
    const username = opts?.username ?? (Config.MEMGRAPH_USER || undefined);
    const password = opts?.password ?? Config.MEMGRAPH_PASSWORD;
    super(uri, username, password);
  }

  async connect(): Promise<boolean> {
    try {
      this.driver = await this.createDriver();
      this._connected = true;
      console.log(`Successfully connected to Memgraph at ${this.uri}`);
      return true;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to connect to Memgraph: ${err}`);
      throw new DatabaseConnectionError(
        `Failed to connect to Memgraph at ${this.uri}: ${err}\n` +
          "Ensure a Memgraph instance is running. Set MEMORY_MEMGRAPH_URI to configure the connection."
      );
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const healthInfo: HealthCheckResult = {
      connected: this._connected,
      backend_type: "memgraph",
      uri: this.uri,
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
    return "memgraph";
  }

  static async create(
    opts?: { uri?: string; username?: string; password?: string }
  ): Promise<MemgraphBackend> {
    const backend = new MemgraphBackend(opts);
    await backend.connect();
    return backend;
  }
}
