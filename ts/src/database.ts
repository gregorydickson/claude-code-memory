/**
 * High-level database interface for memory operations.
 *
 * Wraps a GraphBackend to provide a consistent interface for tool handlers
 * and CLI commands, regardless of the underlying backend type.
 */

import { randomUUID } from "node:crypto";

import type {
  Memory,
  Relationship,
  RelationshipProperties,
  SearchQuery,
  PaginatedResult,
} from "./models.ts";
import {
  MemoryNotFoundError,
  RelationshipError,
  ValidationError,
  DatabaseConnectionError,
} from "./errors.ts";
import type { GraphBackend } from "./backends/index.ts";
import { createRelationshipProperties } from "./models.ts";

/**
 * Count the FULL match set for a search query by paging through it in
 * batches. Backends expose no COUNT-with-filters method, so this is the
 * only way to get an exact total without a per-backend count query.
 * (VAL-REVIEW-001: a single capped count query truncated at 1000.)
 */
async function countAllMatches(
  backend: Pick<GraphBackend, "searchMemories">,
  searchQuery: SearchQuery
): Promise<number> {
  const COUNT_BATCH = 1000;
  let total = 0;
  let offset = 0;
  // Fetch batches until one comes back short. Any batch of exactly
  // COUNT_BATCH rows may have successors.
  for (;;) {
    const batch = await backend.searchMemories({
      ...searchQuery,
      limit: COUNT_BATCH,
      offset,
    });
    total += batch.length;
    if (batch.length < COUNT_BATCH) return total;
    offset += COUNT_BATCH;
  }
}

export interface IMemoryDatabase {
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
  storeMemory(memory: Memory): Promise<string>;
  getMemory(memoryId: string, includeRelationships?: boolean): Promise<Memory | null>;
  searchMemories(searchQuery: SearchQuery): Promise<Memory[]>;
  searchMemoriesPaginated?(searchQuery: SearchQuery): Promise<PaginatedResult>;
  updateMemory(memory: Memory): Promise<boolean>;
  deleteMemory(memoryId: string): Promise<boolean>;
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
  getMemoryStatistics(): Promise<Record<string, unknown>>;
  getRecentActivity?(days?: number, project?: string | null): Promise<Record<string, unknown>>;
  getRelationshipsSince?(since: Date): Promise<Relationship[]>;

  // M1 (VAL-LOCAL-031): recall differs from search. Delegates to
  // backend.recallMemories when the backend implements it; the wrapper
  // falls back to searchMemories if the backend does not (so `recall`
  // still works on backends without a recall-specific implementation).
  recallMemories?(
    query: string,
    opts?: { memoryTypes?: string[]; projectPath?: string; limit?: number }
  ): Promise<Memory[]>;

  // H7 temporal (VAL-LOCAL-017..019): minimal memory versioning.
  getMemoryStateAt?(memoryId: string, timestamp: Date): Promise<Memory | null>;
  getMemoryVersions?(memoryId: string): Promise<Memory[]>;
}

/**
 * Generic database wrapper for Cypher-capable backends (FalkorDB, Neo4j, etc.).
 * Delegates directly to the backend's own CRUD methods.
 */
export class MemoryDatabase implements IMemoryDatabase {
  backend: GraphBackend;

  constructor(backend: GraphBackend) {
    this.backend = backend;
  }

  async initializeSchema(): Promise<void> {
    await this.backend.initializeSchema();
  }

  async close(): Promise<void> {
    await this.backend.disconnect();
  }

  async storeMemory(memory: Memory): Promise<string> {
    return this.backend.storeMemory(memory);
  }

  async getMemory(memoryId: string, includeRelationships = true): Promise<Memory | null> {
    return this.backend.getMemory(memoryId, includeRelationships);
  }

  async searchMemories(searchQuery: SearchQuery): Promise<Memory[]> {
    return this.backend.searchMemories(searchQuery);
  }

  async searchMemoriesPaginated(searchQuery: SearchQuery): Promise<PaginatedResult> {
    const memories = await this.backend.searchMemories({
      ...searchQuery,
      limit: searchQuery.limit,
      offset: searchQuery.offset,
    });

    // Exact total count: page through the FULL match set in batches. A
    // single count query capped at limit 1000 silently truncated pagination
    // at exactly 1000 matches (has_more flipped false at the boundary), so
    // paginateMemories/getAllMemories stopped after the first batch and
    // exportToJson / migration verification silently dropped everything
    // past the first 1000 rows (VAL-REVIEW-001).
    const totalCount = await countAllMatches(this.backend, searchQuery);
    const hasMore = searchQuery.offset + memories.length < totalCount;
    const nextOffset = hasMore ? searchQuery.offset + searchQuery.limit : undefined;

    return {
      results: memories,
      total_count: totalCount,
      limit: searchQuery.limit,
      offset: searchQuery.offset,
      has_more: hasMore,
      next_offset: nextOffset,
    };
  }

  async updateMemory(memory: Memory): Promise<boolean> {
    return this.backend.updateMemory(memory);
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    return this.backend.deleteMemory(memoryId);
  }

  async createRelationship(
    fromMemoryId: string,
    toMemoryId: string,
    relationshipType: string,
    properties?: RelationshipProperties
  ): Promise<string> {
    return this.backend.createRelationship(fromMemoryId, toMemoryId, relationshipType, properties);
  }

  async getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number; limit?: number }
  ): Promise<[Memory, Relationship][]> {
    return this.backend.getRelatedMemories(memoryId, opts);
  }

  async getMemoryStatistics(): Promise<Record<string, unknown>> {
    if (this.backend.getMemoryStatistics) {
      return this.backend.getMemoryStatistics();
    }
    return {};
  }

  async getRecentActivity(days = 7, project?: string | null): Promise<Record<string, unknown>> {
    if (this.backend.getRecentActivity) {
      return this.backend.getRecentActivity(days, project);
    }
    return {
      total_count: 0,
      memories_by_type: {},
      recent_memories: [],
      unresolved_problems: [],
      days,
      project,
    };
  }

  /**
   * M12 (VAL-LOCAL-014): single backend query filtering relationships by
   * `recorded_at >= since`. Replaces the N+1 per-memory loop in
   * `handleWhatChanged` (which also implicitly capped at 1000 memories via
   * `searchMemories({limit: 1000})`). Backends that do not implement this
   * method yield an empty list (cloud is out of scope).
   */
  async getRelationshipsSince(since: Date): Promise<Relationship[]> {
    if (this.backend.getRelationshipsSince) {
      return this.backend.getRelationshipsSince(since);
    }
    return [];
  }

  /**
   * M1 (VAL-LOCAL-031): recall != search. Delegates to
   * `backend.recallMemories` when the backend implements it; otherwise
   * falls back to `searchMemories` so `recall` still works on backends
   * without a recall-specific implementation (e.g. sqlite, where recall
   * delegates to search by design).
   */
  async recallMemories(
    query: string,
    opts?: { memoryTypes?: string[]; projectPath?: string; limit?: number }
  ): Promise<Memory[]> {
    if (this.backend.recallMemories) {
      return this.backend.recallMemories(query, opts);
    }
    // Fallback: recall reduces to a plain search.
    const searchQuery: SearchQuery = {
      query,
      terms: [],
      memory_types: opts?.memoryTypes ?? [],
      tags: [],
      project_path: opts?.projectPath,
      languages: [],
      frameworks: [],
      min_importance: undefined,
      min_confidence: undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: opts?.limit ?? 20,
      offset: 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    };
    return this.backend.searchMemories(searchQuery);
  }

  /**
   * H7 temporal (VAL-LOCAL-017..019): the memory's state at `timestamp`.
   * Delegates to `backend.getMemoryStateAt` when implemented; otherwise
   * returns the current memory (no versioning available — temporal
   * handlers surface this gracefully).
   */
  async getMemoryStateAt(memoryId: string, timestamp: Date): Promise<Memory | null> {
    if (this.backend.getMemoryStateAt) {
      return this.backend.getMemoryStateAt(memoryId, timestamp);
    }
    // Fallback: return the current memory if it exists, regardless of
    // timestamp. Backends without versioning cannot reconstruct historical
    // state; the caller treats this as "the memory's current state".
    return this.backend.getMemory(memoryId, false);
  }

  /**
   * H7 temporal (VAL-LOCAL-018): the memory's version history. Delegates to
   * `backend.getMemoryVersions` when implemented; otherwise returns a
   * single-element list with the current memory (no versioning available).
   */
  async getMemoryVersions(memoryId: string): Promise<Memory[]> {
    if (this.backend.getMemoryVersions) {
      return this.backend.getMemoryVersions(memoryId);
    }
    // Fallback: a single-element list containing the current memory.
    const current = await this.backend.getMemory(memoryId, false);
    return current ? [current] : [];
  }
}

/**
 * Cloud-specific database wrapper.
 * Provides the same interface as MemoryDatabase but delegates to cloud REST API.
 */
export class CloudMemoryDatabase implements IMemoryDatabase {
  backend: GraphBackend;

  constructor(backend: GraphBackend) {
    this.backend = backend;
  }

  async initializeSchema(): Promise<void> {
    await this.backend.initializeSchema();
  }

  async close(): Promise<void> {
    await this.backend.disconnect();
  }

  async storeMemory(memory: Memory): Promise<string> {
    if (!memory.id) memory.id = randomUUID();
    return this.backend.storeMemory(memory);
  }

  async getMemory(memoryId: string, _includeRelationships = true): Promise<Memory | null> {
    return this.backend.getMemory(memoryId);
  }

  async searchMemories(searchQuery: SearchQuery): Promise<Memory[]> {
    return this.backend.searchMemories(searchQuery);
  }

  async searchMemoriesPaginated(searchQuery: SearchQuery): Promise<PaginatedResult> {
    const memories = await this.backend.searchMemories(searchQuery);
    const hasMore = memories.length === searchQuery.limit;
    const nextOffset = hasMore ? searchQuery.offset + searchQuery.limit : undefined;
    return {
      results: memories,
      total_count: -1, // unknown for cloud
      limit: searchQuery.limit,
      offset: searchQuery.offset,
      has_more: hasMore,
      next_offset: nextOffset,
    };
  }

  async updateMemory(memory: Memory): Promise<boolean> {
    return this.backend.updateMemory(memory);
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    return this.backend.deleteMemory(memoryId);
  }

  async createRelationship(
    fromMemoryId: string,
    toMemoryId: string,
    relationshipType: string,
    properties?: RelationshipProperties
  ): Promise<string> {
    return this.backend.createRelationship(fromMemoryId, toMemoryId, relationshipType, properties);
  }

  async getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number; limit?: number }
  ): Promise<[Memory, Relationship][]> {
    return this.backend.getRelatedMemories(memoryId, opts);
  }

  async getMemoryStatistics(): Promise<Record<string, unknown>> {
    if (this.backend.getMemoryStatistics) {
      return this.backend.getMemoryStatistics();
    }
    return {};
  }

  async getRecentActivity(days = 7, project?: string | null): Promise<Record<string, unknown>> {
    if (this.backend.getRecentActivity) {
      return this.backend.getRecentActivity(days, project);
    }
    return {
      total_count: 0,
      memories_by_type: {},
      recent_memories: [],
      unresolved_problems: [],
      days,
      project,
    };
  }

  async getRelationshipsSince(since: Date): Promise<Relationship[]> {
    if (this.backend.getRelationshipsSince) {
      return this.backend.getRelationshipsSince(since);
    }
    return [];
  }

  async recallMemories(
    query: string,
    opts?: { memoryTypes?: string[]; projectPath?: string; limit?: number }
  ): Promise<Memory[]> {
    if (this.backend.recallMemories) {
      return this.backend.recallMemories(query, opts);
    }
    const searchQuery: SearchQuery = {
      query,
      terms: [],
      memory_types: opts?.memoryTypes ?? [],
      tags: [],
      project_path: opts?.projectPath,
      languages: [],
      frameworks: [],
      min_importance: undefined,
      min_confidence: undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: opts?.limit ?? 20,
      offset: 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    };
    return this.backend.searchMemories(searchQuery);
  }

  async getMemoryStateAt(memoryId: string, timestamp: Date): Promise<Memory | null> {
    if (this.backend.getMemoryStateAt) {
      return this.backend.getMemoryStateAt(memoryId, timestamp);
    }
    return this.backend.getMemory(memoryId, false);
  }

  async getMemoryVersions(memoryId: string): Promise<Memory[]> {
    if (this.backend.getMemoryVersions) {
      return this.backend.getMemoryVersions(memoryId);
    }
    const current = await this.backend.getMemory(memoryId, false);
    return current ? [current] : [];
  }
}
