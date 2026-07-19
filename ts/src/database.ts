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
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[Memory, Relationship][]>;
  getMemoryStatistics(): Promise<Record<string, unknown>>;
  getRecentActivity?(days?: number, project?: string | null): Promise<Record<string, unknown>>;
  getRelationshipsSince?(since: Date): Promise<Relationship[]>;
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
    // For Cypher backends that support pagination, query total count
    const memories = await this.backend.searchMemories({
      ...searchQuery,
      limit: searchQuery.limit,
      offset: searchQuery.offset,
    });

    // Get total count (simplified - in production, run a separate count query)
    const allMatches = await this.backend.searchMemories({
      ...searchQuery,
      limit: 1000,
      offset: 0,
    });
    const totalCount = allMatches.length;
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
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
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
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
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
}
