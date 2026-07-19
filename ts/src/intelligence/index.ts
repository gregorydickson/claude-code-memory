/**
 * Intelligence Layer - AI-powered features for the memory server.
 *
 * Port of the Python `memorygraph.intelligence` package.
 * Provides:
 * - Automatic entity extraction from memory content
 * - Pattern recognition and similarity matching
 * - Temporal memory tracking and version history
 * - Context-aware intelligent retrieval
 */

export {
  EntityType,
  ALL_ENTITY_TYPES,
  isEntityType,
  EntitySchema,
  EntityExtractor,
  extractEntities,
  linkEntities,
  type Entity,
} from "./entity-extraction.ts";

export {
  PatternRecognizer,
  findSimilarProblems,
  extractPatterns,
  suggestPatterns,
  type Pattern,
} from "./pattern-recognition.ts";

export {
  TemporalMemory,
  getMemoryHistory,
  getStateAt,
  trackEntityChanges,
  type MemoryVersion,
  type MemoryState,
  type EntityChange,
  type VersionDiff,
} from "./temporal.ts";

export {
  ContextRetriever,
  getContext,
  getProjectContext,
  getSessionContext,
  type QueryContext,
  type SourceMemory,
  type ProjectSummary,
  type SessionContext,
} from "./context-retrieval.ts";
