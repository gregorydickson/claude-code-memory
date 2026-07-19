/**
 * Configuration management for MemoryGraph.
 *
 * Centralises all configuration options and environment variable handling.
 * Each getter reads from the environment at call time, making Config
 * reactive to runtime env changes.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DB_PATH = join(homedir(), ".memorygraph", "memory.db");
const DEFAULT_FALKORDBLITE_PATH = join(homedir(), ".memorygraph", "falkordblite.db");
const DEFAULT_LADYBUGDB_PATH = join(homedir(), ".memorygraph", "ladybugdb.db");

export type BackendType =
  | "neo4j"
  | "memgraph"
  | "sqlite"
  | "turso"
  | "cloud"
  | "falkordb"
  | "falkordblite"
  | "ladybugdb"
  | "auto";

export const ALL_BACKEND_TYPES: BackendType[] = [
  "neo4j",
  "memgraph",
  "sqlite",
  "turso",
  "cloud",
  "falkordb",
  "falkordblite",
  "ladybugdb",
  "auto",
];

const CORE_TOOLS = [
  "store_memory",
  "get_memory",
  "search_memories",
  "update_memory",
  "delete_memory",
  "create_relationship",
  "get_related_memories",
  "recall_memories",
  "get_recent_activity",
];

const EXTENDED_EXTRA_TOOLS = [
  "get_memory_statistics",
  "search_relationships_by_context",
  "contextual_search",
];

export const TOOL_PROFILES: Record<string, string[]> = {
  core: CORE_TOOLS,
  extended: [...CORE_TOOLS, ...EXTENDED_EXTRA_TOOLS],
};

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function env(names: string[]): string | undefined {
  for (const name of names) {
    const val = process.env[name];
    if (val !== undefined) return val;
  }
  return undefined;
}

function envStr(names: string[], fallback: string): string {
  return env(names) ?? fallback;
}

function envInt(names: string[], fallback: number): number {
  const raw = env(names);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envFloat(names: string[], fallback: number): number {
  const raw = env(names);
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? fallback : n;
}

function envBool(names: string[], fallback: boolean): boolean {
  const raw = env(names);
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true";
}

function envIsSet(names: string[]): boolean {
  return names.some((n) => n in process.env);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export class Config {
  // Backend
  static get BACKEND(): string {
    return envStr(["MEMORY_BACKEND"], "falkordblite");
  }

  // Neo4j
  static get NEO4J_URI(): string {
    return envStr(["MEMORY_NEO4J_URI", "NEO4J_URI"], "bolt://localhost:7687");
  }
  static get NEO4J_USER(): string {
    return envStr(["MEMORY_NEO4J_USER", "NEO4J_USER"], "neo4j");
  }
  static get NEO4J_PASSWORD(): string | undefined {
    return env(["MEMORY_NEO4J_PASSWORD", "NEO4J_PASSWORD"]);
  }
  static get NEO4J_DATABASE(): string {
    return envStr(["MEMORY_NEO4J_DATABASE"], "neo4j");
  }

  // Memgraph
  static get MEMGRAPH_URI(): string {
    return envStr(["MEMORY_MEMGRAPH_URI"], "bolt://localhost:7687");
  }
  static get MEMGRAPH_USER(): string {
    return envStr(["MEMORY_MEMGRAPH_USER"], "");
  }
  static get MEMGRAPH_PASSWORD(): string | undefined {
    return env(["MEMORY_MEMGRAPH_PASSWORD"]);
  }

  // SQLite
  static get SQLITE_PATH(): string {
    return envStr(["MEMORY_SQLITE_PATH"], DEFAULT_DB_PATH);
  }

  // Turso
  static get TURSO_PATH(): string {
    return envStr(["MEMORY_TURSO_PATH"], DEFAULT_DB_PATH);
  }
  static get TURSO_DATABASE_URL(): string | undefined {
    return env(["TURSO_DATABASE_URL"]);
  }
  static get TURSO_AUTH_TOKEN(): string | undefined {
    return env(["TURSO_AUTH_TOKEN"]);
  }

  // Cloud
  static get MEMORYGRAPH_API_KEY(): string | undefined {
    return env(["MEMORYGRAPH_API_KEY"]);
  }
  static get MEMORYGRAPH_API_URL(): string {
    return envStr(["MEMORYGRAPH_API_URL"], "https://graph-api.memorygraph.dev");
  }
  static get MEMORYGRAPH_TIMEOUT(): number {
    return envInt(["MEMORYGRAPH_TIMEOUT"], 30);
  }
  static get CLOUD_MAX_RETRIES(): number {
    return envInt(["MEMORYGRAPH_MAX_RETRIES"], 3);
  }
  static get CLOUD_RETRY_BACKOFF_BASE(): number {
    return envFloat(["MEMORYGRAPH_RETRY_BACKOFF"], 1.0);
  }
  static get CLOUD_CIRCUIT_BREAKER_THRESHOLD(): number {
    return envInt(["MEMORYGRAPH_CB_THRESHOLD"], 5);
  }
  static get CLOUD_CIRCUIT_BREAKER_TIMEOUT(): number {
    return envFloat(["MEMORYGRAPH_CB_TIMEOUT"], 60.0);
  }

  // FalkorDB
  static get FALKORDB_HOST(): string {
    return envStr(["MEMORY_FALKORDB_HOST", "FALKORDB_HOST"], "localhost");
  }
  static get FALKORDB_PORT(): number {
    return envInt(["MEMORY_FALKORDB_PORT", "FALKORDB_PORT"], 6379);
  }
  static get FALKORDB_PASSWORD(): string | undefined {
    return env(["MEMORY_FALKORDB_PASSWORD", "FALKORDB_PASSWORD"]);
  }

  // FalkorDBLite
  static get FALKORDBLITE_PATH(): string {
    return envStr(["MEMORY_FALKORDBLITE_PATH", "FALKORDBLITE_PATH"], DEFAULT_FALKORDBLITE_PATH);
  }

  // Bounded query timeout (ms) — enforced at the BaseFalkorDBBackend and
  // BaseBoltBackend executeQuery choke points so a hung query degrades to a
  // typed TimeoutError instead of hanging the caller. Default 5000ms.
  static get QUERY_TIMEOUT(): number {
    return envInt(["MEMORYGRAPH_QUERY_TIMEOUT"], 5000);
  }

  // LadybugDB
  static get LADYBUGDB_PATH(): string {
    return envStr(["MEMORY_LADYBUGDB_PATH", "LADYBUGDB_PATH"], DEFAULT_LADYBUGDB_PATH);
  }

  // Tool profile
  static get TOOL_PROFILE(): string {
    return envStr(["MEMORY_TOOL_PROFILE"], "core");
  }

  // Logging
  static get LOG_LEVEL(): string {
    return envStr(["MEMORY_LOG_LEVEL"], "INFO");
  }

  // Features
  static get AUTO_EXTRACT_ENTITIES(): boolean {
    return envBool(["MEMORY_AUTO_EXTRACT_ENTITIES"], true);
  }
  static get SESSION_BRIEFING(): boolean {
    return envBool(["MEMORY_SESSION_BRIEFING"], true);
  }
  static get BRIEFING_VERBOSITY(): string {
    return envStr(["MEMORY_BRIEFING_VERBOSITY"], "standard");
  }
  static get BRIEFING_RECENCY_DAYS(): number {
    return envInt(["MEMORY_BRIEFING_RECENCY_DAYS"], 7);
  }

  // Relationships
  static get ALLOW_RELATIONSHIP_CYCLES(): boolean {
    return envBool(["MEMORY_ALLOW_CYCLES"], false);
  }

  // Multi-tenancy
  static get MULTI_TENANT_MODE(): boolean {
    return envBool(["MEMORY_MULTI_TENANT_MODE"], false);
  }
  static get DEFAULT_TENANT(): string {
    return envStr(["MEMORY_DEFAULT_TENANT"], "default");
  }
  static get REQUIRE_AUTH(): boolean {
    return envBool(["MEMORY_REQUIRE_AUTH"], false);
  }

  // Auth
  static get AUTH_PROVIDER(): string {
    return envStr(["MEMORY_AUTH_PROVIDER"], "none");
  }
  static get JWT_SECRET(): string | undefined {
    return env(["MEMORY_JWT_SECRET"]);
  }
  static get JWT_ALGORITHM(): string {
    return envStr(["MEMORY_JWT_ALGORITHM"], "HS256");
  }

  // Audit
  static get ENABLE_AUDIT_LOG(): boolean {
    return envBool(["MEMORY_ENABLE_AUDIT_LOG"], false);
  }

  // --- Class methods ---

  static getBackendType(): BackendType {
    const backendStr = Config.BACKEND.toLowerCase() as BackendType;
    if (ALL_BACKEND_TYPES.includes(backendStr)) return backendStr;
    return "auto";
  }

  static isEnvSet(attrName: string): boolean {
    const envMap: Record<string, string[]> = {
      NEO4J_PASSWORD: ["MEMORY_NEO4J_PASSWORD", "NEO4J_PASSWORD"],
      MEMGRAPH_URI: ["MEMORY_MEMGRAPH_URI"],
      FALKORDB_HOST: ["MEMORY_FALKORDB_HOST", "FALKORDB_HOST"],
      MEMORYGRAPH_API_KEY: ["MEMORYGRAPH_API_KEY"],
      TURSO_DATABASE_URL: ["TURSO_DATABASE_URL"],
      TURSO_PATH: ["MEMORY_TURSO_PATH"],
    };
    const names = envMap[attrName];
    if (names) return envIsSet(names);
    return false;
  }

  static isNeo4jConfigured(): boolean {
    return Config.isEnvSet("NEO4J_PASSWORD");
  }

  static isMemgraphConfigured(): boolean {
    return Config.isEnvSet("MEMGRAPH_URI");
  }

  static isMultiTenantMode(): boolean {
    return Config.MULTI_TENANT_MODE;
  }

  static getDefaultTenant(): string {
    return Config.DEFAULT_TENANT;
  }

  static getEnabledTools(): string[] | null {
    const profile = Config.TOOL_PROFILE.toLowerCase();
    const legacyMap: Record<string, string> = {
      lite: "core",
      standard: "extended",
      full: "extended",
    };
    const resolved = legacyMap[profile] ?? profile;
    return TOOL_PROFILES[resolved] ?? TOOL_PROFILES["core"];
  }

  static getConfigSummary(): Record<string, unknown> {
    return {
      backend: Config.BACKEND,
      neo4j: {
        uri: Config.NEO4J_URI,
        user: Config.NEO4J_USER,
        password_configured: !!Config.NEO4J_PASSWORD,
        database: Config.NEO4J_DATABASE,
      },
      memgraph: {
        uri: Config.MEMGRAPH_URI,
        user: Config.MEMGRAPH_USER,
        password_configured: !!Config.MEMGRAPH_PASSWORD,
      },
      sqlite: { path: Config.SQLITE_PATH },
      turso: {
        path: Config.TURSO_PATH,
        database_url: Config.TURSO_DATABASE_URL,
        auth_token_configured: !!Config.TURSO_AUTH_TOKEN,
      },
      cloud: {
        api_url: Config.MEMORYGRAPH_API_URL,
        api_key_configured: !!Config.MEMORYGRAPH_API_KEY,
        timeout: Config.MEMORYGRAPH_TIMEOUT,
      },
      falkordb: {
        host: Config.FALKORDB_HOST,
        port: Config.FALKORDB_PORT,
        password_configured: !!Config.FALKORDB_PASSWORD,
      },
      falkordblite: { path: Config.FALKORDBLITE_PATH },
      logging: { level: Config.LOG_LEVEL },
      features: {
        auto_extract_entities: Config.AUTO_EXTRACT_ENTITIES,
        session_briefing: Config.SESSION_BRIEFING,
        briefing_verbosity: Config.BRIEFING_VERBOSITY,
        briefing_recency_days: Config.BRIEFING_RECENCY_DAYS,
      },
      relationships: { allow_cycles: Config.ALLOW_RELATIONSHIP_CYCLES },
      multi_tenancy: {
        enabled: Config.MULTI_TENANT_MODE,
        default_tenant: Config.DEFAULT_TENANT,
        require_auth: Config.REQUIRE_AUTH,
        auth_provider: Config.AUTH_PROVIDER,
        jwt_secret_configured: !!Config.JWT_SECRET,
        audit_log_enabled: Config.ENABLE_AUDIT_LOG,
      },
    };
  }
}
