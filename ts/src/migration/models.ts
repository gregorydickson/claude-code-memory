/**
 * Data models for backend migration.
 *
 * Provides configuration, options, and result interfaces for migrating
 * memories between different backend types.
 */

import { Config, type BackendType } from "../config.ts";

export interface BackendConfig {
  backend_type: BackendType;
  path?: string;
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
  api_url?: string;
  api_key?: string;
}

export function backendConfigFromEnv(): BackendConfig {
  const backendType = Config.getBackendType();
  let uri: string | undefined;
  let username: string | undefined;
  let password: string | undefined;
  let path: string | undefined;

  if (backendType === "neo4j") {
    uri = Config.NEO4J_URI;
    username = Config.NEO4J_USER;
    password = Config.NEO4J_PASSWORD;
  } else if (backendType === "memgraph") {
    uri = Config.MEMGRAPH_URI;
    username = Config.MEMGRAPH_USER;
    password = Config.MEMGRAPH_PASSWORD;
  } else if (backendType === "falkordb") {
    uri = `redis://${Config.FALKORDB_HOST}:${Config.FALKORDB_PORT}`;
    password = Config.FALKORDB_PASSWORD;
  } else if (backendType === "sqlite") {
    path = Config.SQLITE_PATH;
  } else if (backendType === "falkordblite") {
    path = Config.FALKORDBLITE_PATH;
  } else if (backendType === "cloud") {
    return {
      backend_type: backendType,
      api_key: Config.MEMORYGRAPH_API_KEY,
      api_url: Config.MEMORYGRAPH_API_URL,
    };
  }

  return {
    backend_type: backendType,
    path,
    uri,
    username,
    password,
  };
}

export function validateBackendConfig(config: BackendConfig): string[] {
  const errors: string[] = [];

  if (config.backend_type === "sqlite" || config.backend_type === "falkordblite") {
    if (!config.path) {
      errors.push(`${config.backend_type} backend requires 'path' parameter`);
    }
  } else if (
    config.backend_type === "neo4j" ||
    config.backend_type === "memgraph" ||
    config.backend_type === "falkordb"
  ) {
    if (!config.uri) {
      errors.push(`${config.backend_type} backend requires 'uri' parameter`);
    }
  } else if (config.backend_type === "cloud") {
    if (!config.api_url) {
      errors.push("cloud backend requires 'api_url' parameter");
    }
    if (!config.api_key) {
      errors.push("cloud backend requires 'api_key' parameter");
    }
  } else {
    errors.push(`Unknown backend type: ${config.backend_type}`);
  }

  return errors;
}

export interface MigrationOptions {
  dry_run: boolean;
  verbose: boolean;
  skip_duplicates: boolean;
  verify: boolean;
  rollback_on_failure: boolean;
  since?: string;
}

export function createMigrationOptions(overrides?: Partial<MigrationOptions>): MigrationOptions {
  return {
    dry_run: false,
    verbose: false,
    skip_duplicates: true,
    verify: true,
    rollback_on_failure: true,
    since: undefined,
    ...overrides,
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface VerificationResult {
  valid: boolean;
  errors: string[];
  source_count: number;
  target_count: number;
  sample_checks: number;
  sample_passed: number;
}

export interface MigrationResult {
  success: boolean;
  dry_run: boolean;
  source_stats?: Record<string, unknown>;
  target_stats?: Record<string, unknown>;
  imported_memories: number;
  imported_relationships: number;
  skipped_memories: number;
  verification_result?: VerificationResult;
  duration_seconds: number;
  errors: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}
