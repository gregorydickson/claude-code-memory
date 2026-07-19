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
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[Memory, Relationship][]>;

  // Statistics
  getMemoryStatistics?(): Promise<Record<string, unknown>>;

  // Recent activity (optional, not all backends support it)
  getRecentActivity?(days?: number, project?: string | null): Promise<Record<string, unknown>>;

  // Backend-specific search (optional, for cloud backend)
  recallMemories?(
    query: string,
    opts?: { memoryTypes?: string[]; projectPath?: string; limit?: number }
  ): Promise<Memory[]>;
}

// Re-export for convenience
export type { Memory, Relationship, RelationshipType, RelationshipProperties, SearchQuery };
