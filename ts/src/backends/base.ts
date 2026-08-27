/**
 * Abstract base interface for graph database backends.
 *
 * All backend implementations (FalkorDB, Cloud, SQLite) must implement
 * this interface to ensure compatibility with the memory system.
 */

import type {
  Memory,
  Relationship,
  RelationshipType,
  RelationshipProperties,
  SearchQuery,
} from "../models.ts";

export interface HealthCheckResult {
  connected: boolean;
  backend_type: string;
  [key: string]: unknown;
}

export interface GraphBackend {
  // Connection lifecycle
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;

  // Query execution (for Cypher-capable backends)
  executeQuery(
    query: string,
    parameters?: Record<string, unknown>,
    write?: boolean
  ): Promise<Record<string, unknown>[]>;

  // Schema
  initializeSchema(): Promise<void>;

  // Health
  healthCheck(): Promise<HealthCheckResult>;

  // Capabilities
  backendName(): string;
  supportsFulltextSearch(): boolean;
  supportsTransactions(): boolean;
  isCypherCapable(): boolean;

  // Memory CRUD
  storeMemory(memory: Memory): Promise<string>;
  getMemory(memoryId: string, includeRelationships?: boolean): Promise<Memory | null>;
  searchMemories(searchQuery: SearchQuery): Promise<Memory[]>;
  updateMemory(memory: Memory): Promise<boolean>;
  deleteMemory(memoryId: string): Promise<boolean>;

  // Relationships
  createRelationship(
    fromMemoryId: string,
    toMemoryId: string,
    relationshipType: string,
    properties?: RelationshipProperties
  ): Promise<string>;
  getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number; limit?: number }
  ): Promise<[Memory, Relationship][]>;

  // Statistics
  getMemoryStatistics?(): Promise<Record<string, unknown>>;

  // Recent activity (optional, not all backends support it)
  getRecentActivity?(days?: number, project?: string | null): Promise<Record<string, unknown>>;

  // Relationships recorded since a timestamp (used by `changes`/what-changed).
  // M12 (VAL-LOCAL-014): replaces the N+1 per-memory query + implicit 1000-cap
  // with a single backend query filtering relationships by recorded_at >= since.
  getRelationshipsSince?(since: Date): Promise<Relationship[]>;

  // Backend-specific search (optional, for cloud backend)
  recallMemories?(
    query: string,
    opts?: { memoryTypes?: string[]; projectPath?: string; limit?: number }
  ): Promise<Memory[]>;

  // H7 temporal — minimal memory versioning (M5 / VAL-LOCAL-017..019).
  // Backends that implement these snapshot the prior memory state on
  // `updateMemory` into a version store so `as-of` / `history` can return
  // the memory's state at an arbitrary timestamp. Backends that do not
  // implement them leave temporal queries to the relationship-based path
  // (which still works for relationships but not for memory content).
  getMemoryStateAt?(memoryId: string, timestamp: Date): Promise<Memory | null>;
  getMemoryVersions?(memoryId: string): Promise<Memory[]>;
}

// Re-export for convenience
export type { Memory, Relationship, RelationshipType, RelationshipProperties, SearchQuery };
