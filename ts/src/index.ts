/**
 * MemoryGraph - Graph-based memory CLI for AI coding agents.
 *
 * TypeScript/Bun port of the Python memorygraph MCP server.
 * Changed from MCP server to CLI interface.
 * Local storage via FalkorDBLite or SQLite, cloud sync via MemoryGraph Cloud API.
 */

export const VERSION = "0.14.0";

// Models
export {
  MemoryType,
  RelationshipType,
  isMemoryType,
  isRelationshipType,
  ALL_MEMORY_TYPES,
  ALL_RELATIONSHIP_TYPES,
  MemorySchema,
  MemoryContextSchema,
  RelationshipSchema,
  RelationshipPropertiesSchema,
  SearchQuerySchema,
  PaginatedResultSchema,
  MemoryGraphSchema,
  AnalysisResultSchema,
  memoryToNodeProperties,
  createMemory,
  createRelationshipProperties,
  parseDate,
  type Memory,
  type MemoryContext,
  type Relationship,
  type RelationshipProperties,
  type SearchQuery,
  type PaginatedResult,
  type MemoryGraph,
  type AnalysisResult,
  type MemoryNode,
} from "./models.ts";

// Errors
export {
  MemoryError,
  MemoryNotFoundError,
  RelationshipError,
  ValidationError,
  DatabaseConnectionError,
  SchemaError,
  NotFoundError,
  BackendError,
  ConfigurationError,
} from "./errors.ts";

// Config
export { Config, TOOL_PROFILES, type BackendType, ALL_BACKEND_TYPES } from "./config.ts";

// Backends
export {
  type GraphBackend,
  type HealthCheckResult,
  BaseFalkorDBBackend,
  FalkorDBLiteBackend,
  FalkorDBBackend,
  BaseBoltBackend,
  MemgraphBackend,
  CloudRESTAdapter,
  CloudBackend,
  CircuitBreaker,
  SQLiteBackend,
} from "./backends/index.ts";

export { BackendFactory } from "./backends/factory.ts";

// Database
export { MemoryDatabase, CloudMemoryDatabase, type IMemoryDatabase } from "./database.ts";

// Tools
export {
  handleStoreMemory,
  handleGetMemory,
  handleUpdateMemory,
  handleDeleteMemory,
  handleSearchMemories,
  handleRecallMemories,
  handleContextualSearch,
  handleCreateRelationship,
  handleGetRelatedMemories,
  handleGetMemoryStatistics,
  handleGetRecentActivity,
  handleQueryAsOf,
  handleGetRelationshipHistory,
  handleWhatChanged,
} from "./tools/index.ts";

// Utils
export {
  utcNow,
  parseDatetime,
  ensureAware,
  parseMemoryFromProperties,
  validateMemoryInput,
  validateSearchInput,
  validateRelationshipInput,
  detectProjectContext,
  extractContextStructure,
  parseContext,
  hasCycle,
  exportToJson,
  importFromJson,
  exportToMarkdown,
} from "./utils/index.ts";

// Migration
export {
  type BackendConfig,
  type MigrationOptions,
  type MigrationResult,
  MigrationManager,
  MigrationError,
  backendConfigFromEnv,
  createMigrationOptions,
} from "./migration/index.ts";

// Intelligence
export * as intelligence from "./intelligence/index.ts";

// Analytics
export * as analytics from "./analytics/index.ts";

// Proactive
export * as proactive from "./proactive/index.ts";

// Integration
export * as integration from "./integration/index.ts";

// SDK
export * as sdk from "./sdk/index.ts";

// CLI entry point is NOT auto-launched on import. Callers who want the CLI
// must run `src/cli.ts` directly (or the compiled binary). Importing this
// library as a module is side-effect-free.
