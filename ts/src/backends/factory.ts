/**
 * Backend factory for automatic backend selection.
 *
 * Default: FalkorDBLite (local graph database with Cypher support)
 * Falls back to SQLite for zero-server embedded storage.
 */

import { Config, type BackendType } from "../config.js";
import { DatabaseConnectionError } from "../errors.js";
import type { GraphBackend, HealthCheckResult } from "./index.js";
import type { Memory, Relationship, RelationshipProperties, SearchQuery } from "../models.js";

const VALID_BACKENDS =
  "neo4j, memgraph, falkordb, falkordblite, sqlite, turso, ladybugdb, cloud, auto";

const BACKEND_NAMES: Record<string, string> = {
  neo4j: "Neo4j",
  memgraph: "Memgraph",
  falkordb: "FalkorDB",
  falkordblite: "FalkorDBLite",
  sqlite: "SQLite",
  turso: "Turso",
  cloud: "Cloud (MemoryGraph Cloud)",
  ladybugdb: "LadybugDB",
};

export class BackendFactory {
  static async createBackend(): Promise<GraphBackend> {
    // TEST-ONLY injection hook: when MEMORYGRAPH_TEST_INJECT_THROW=1 is set,
    // return a backend whose every operation throws a synthetic error
    // containing a SECRET payload. Used by the never-throw sweep test
    // (VAL-CROSS-005) to verify no CLI command escapes an unhandled
    // exception / raw stack / sensitive data to the caller. This hook is
    // never active in normal operation.
    if (process.env.MEMORYGRAPH_TEST_INJECT_THROW === "1") {
      return new ThrowingBackend();
    }

    const backendType = Config.BACKEND.toLowerCase();

    if (backendType === "auto") {
      console.log("Auto-selecting backend...");
      return BackendFactory.autoSelectBackend();
    }

    const displayName = BACKEND_NAMES[backendType];
    if (!displayName) {
      throw new DatabaseConnectionError(
        `Unknown backend type: ${backendType}. Valid options: ${VALID_BACKENDS}`
      );
    }

    console.log(`Explicit backend selection: ${displayName}`);
    return BackendFactory.createBackendByType(backendType as BackendType);
  }

  static async createBackendByType(backendType: string): Promise<GraphBackend> {
    switch (backendType) {
      case "falkordblite":
        return BackendFactory.createFalkorDBLite();
      case "sqlite":
        return BackendFactory.createSQLite();
      case "cloud":
        return BackendFactory.createCloud();
      case "falkordb":
        return BackendFactory.createFalkorDB();
      case "neo4j":
        return BackendFactory.createNeo4j();
      case "memgraph":
        return BackendFactory.createMemgraph();
      case "turso":
        return BackendFactory.createTurso();
      case "ladybugdb":
        return BackendFactory.createLadybugDB();
      default:
        throw new DatabaseConnectionError(
          `Unknown backend type: ${backendType}. Valid options: ${VALID_BACKENDS}`
        );
    }
  }

  static async autoSelectBackend(): Promise<GraphBackend> {
    // Try FalkorDBLite first (default local backend)
    {
      try {
        console.log("Attempting to connect to FalkorDBLite...");
        const backend = await BackendFactory.createFalkorDBLite();
        console.log("Successfully connected to FalkorDBLite backend");
        return backend;
      } catch (err) {
        console.warn(`FalkorDBLite connection failed: ${err}`);
      }
    }

    // Fall back to SQLite (zero-config, always available)
    try {
      console.log("Falling back to SQLite backend...");
      const backend = await BackendFactory.createSQLite();
      console.log("Successfully connected to SQLite backend");
      return backend;
    } catch (err) {
      console.error(`SQLite backend failed: ${err}`);
      throw new DatabaseConnectionError(
        "Could not connect to any backend. Install FalkorDB locally or use SQLite."
      );
    }
  }

  static async createFalkorDBLite(dbPath?: string): Promise<GraphBackend> {
    const { FalkorDBLiteBackend } = await import("./falkordblite.js");
    const path = dbPath ?? Config.FALKORDBLITE_PATH;
    const backend = new FalkorDBLiteBackend(path);
    await backend.connect();
    await backend.initializeSchema();
    return backend;
  }

  static async createSQLite(dbPath?: string): Promise<GraphBackend> {
    const { SQLiteBackend } = await import("./sqlite.js");
    const path = dbPath ?? Config.SQLITE_PATH;
    const backend = new SQLiteBackend(path);
    await backend.connect();
    await backend.initializeSchema();
    return backend;
  }

  static async createCloud(
    apiKey?: string,
    apiUrl?: string,
    timeout?: number
  ): Promise<GraphBackend> {
    const { CloudRESTAdapter } = await import("./cloud.js");
    const key = apiKey ?? Config.MEMORYGRAPH_API_KEY;
    if (!key) {
      throw new DatabaseConnectionError(
        "MEMORYGRAPH_API_KEY is required for cloud backend. Get your API key at https://app.memorygraph.dev"
      );
    }
    const backend = new CloudRESTAdapter(key, apiUrl, timeout);
    await backend.connect();
    return backend;
  }

  static async createFalkorDB(
    host?: string,
    port?: number,
    password?: string
  ): Promise<GraphBackend> {
    const { FalkorDBBackend } = await import("./falkordb.js");
    const backend = new FalkorDBBackend({
      host,
      port,
      password,
    });
    await backend.connect();
    await backend.initializeSchema();
    return backend;
  }

  static async createNeo4j(): Promise<GraphBackend> {
    throw new DatabaseConnectionError(
      "Neo4j backend not yet implemented in TypeScript port. Use --backend falkordblite, --backend sqlite, --backend memgraph, or --backend falkordb."
    );
  }

  static async createMemgraph(
    uri?: string,
    username?: string,
    password?: string
  ): Promise<GraphBackend> {
    const { MemgraphBackend } = await import("./memgraph.js");
    const backend = new MemgraphBackend({ uri, username, password });
    await backend.connect();
    await backend.initializeSchema();
    return backend;
  }

  static async createTurso(): Promise<GraphBackend> {
    throw new DatabaseConnectionError(
      "Turso backend not yet implemented in TypeScript port. Use --backend falkordblite or --backend sqlite."
    );
  }

  static async createLadybugDB(): Promise<GraphBackend> {
    throw new DatabaseConnectionError(
      "LadybugDB backend not yet implemented in TypeScript port. Use --backend falkordblite or --backend sqlite."
    );
  }

  static getConfiguredBackendType(): string {
    return Config.BACKEND.toLowerCase();
  }

  static isBackendConfigured(backendType: string): boolean {
    const checks: Record<string, () => boolean> = {
      neo4j: () => Config.isEnvSet("NEO4J_PASSWORD"),
      memgraph: () => Config.isEnvSet("MEMGRAPH_URI"),
      falkordb: () => Config.isEnvSet("FALKORDB_HOST"),
      falkordblite: () => true,
      sqlite: () => true,
      turso: () => Config.isEnvSet("TURSO_DATABASE_URL") || Config.isEnvSet("TURSO_PATH"),
      cloud: () => Config.isEnvSet("MEMORYGRAPH_API_KEY"),
      ladybugdb: () => true,
    };
    const check = checks[backendType];
    return check ? check() : false;
  }
}

/**
 * TEST-ONLY backend whose every operation throws a synthetic error
 * containing a SECRET payload. Activated by `MEMORYGRAPH_TEST_INJECT_THROW=1`
 * in `BackendFactory.createBackend()`. Used by the never-throw sweep test
 * (VAL-CROSS-005) to verify the integration boundary catches backend throws
 * and surfaces only a generic message (no SECRET, no raw stack).
 *
 * Never used in normal operation.
 */
class ThrowingBackend implements GraphBackend {
  private boom(): never {
    throw new Error(
      "ThrowingBackend: synthetic backend throw — SECRET=password=hunter2, token=abc123"
    );
  }

  async connect(): Promise<boolean> {
    this.boom();
  }
  async disconnect(): Promise<void> {
    this.boom();
  }
  async executeQuery(
    _query: string,
    _parameters?: Record<string, unknown>,
    _write?: boolean
  ): Promise<Record<string, unknown>[]> {
    this.boom();
  }
  async initializeSchema(): Promise<void> {
    this.boom();
  }
  async healthCheck(): Promise<HealthCheckResult> {
    this.boom();
  }
  backendName(): string {
    return "throwing";
  }
  supportsFulltextSearch(): boolean {
    return false;
  }
  supportsTransactions(): boolean {
    return false;
  }
  isCypherCapable(): boolean {
    return false;
  }
  async storeMemory(_memory: Memory): Promise<string> {
    this.boom();
  }
  async getMemory(_memoryId: string, _includeRelationships?: boolean): Promise<Memory | null> {
    this.boom();
  }
  async searchMemories(_searchQuery: SearchQuery): Promise<Memory[]> {
    this.boom();
  }
  async updateMemory(_memory: Memory): Promise<boolean> {
    this.boom();
  }
  async deleteMemory(_memoryId: string): Promise<boolean> {
    this.boom();
  }
  async createRelationship(
    _fromMemoryId: string,
    _toMemoryId: string,
    _relationshipType: string,
    _properties?: RelationshipProperties
  ): Promise<string> {
    this.boom();
  }
  async getRelatedMemories(
    _memoryId: string,
    _opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[Memory, Relationship][]> {
    this.boom();
  }
  async getMemoryStatistics(): Promise<Record<string, unknown>> {
    this.boom();
  }
  async getRecentActivity(_days?: number, _project?: string | null): Promise<Record<string, unknown>> {
    this.boom();
  }
}
