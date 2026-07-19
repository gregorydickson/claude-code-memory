/**
 * Pagination utilities for working with memories across different backends.
 */

import type { Memory, SearchQuery } from "../models.ts";

export interface DBLike {
  searchMemories(query: SearchQuery): Promise<Memory[]>;
  searchMemoriesPaginated?(query: SearchQuery): Promise<import("../models.ts").PaginatedResult>;
}

export async function* paginateMemories(
  db: DBLike,
  batchSize = 1000,
  progressCallback?: (total: number) => void
): AsyncGenerator<Memory[]> {
  let offset = 0;
  let totalYielded = 0;

  while (true) {
    const query: SearchQuery = {
      query: undefined,
      terms: [],
      memory_types: [],
      tags: [],
      project_path: undefined,
      languages: [],
      frameworks: [],
      min_importance: undefined,
      min_confidence: undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: batchSize,
      offset,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    };

    let memories: Memory[];
    let hasMore: boolean;

    if (db.searchMemoriesPaginated) {
      const result = await db.searchMemoriesPaginated(query);
      memories = result.results;
      hasMore = result.has_more;
    } else {
      memories = await db.searchMemories(query);
      hasMore = memories.length >= batchSize;
    }

    if (memories.length > 0) {
      yield memories;
      totalYielded += memories.length;
      progressCallback?.(totalYielded);
    }

    if (!hasMore || memories.length === 0) break;
    offset += batchSize;
  }
}

export async function countMemories(db: DBLike): Promise<number> {
  const query: SearchQuery = {
    query: undefined,
    terms: [],
    memory_types: [],
    tags: [],
    project_path: undefined,
    languages: [],
    frameworks: [],
    min_importance: undefined,
    min_confidence: undefined,
    min_effectiveness: undefined,
    created_after: undefined,
    created_before: undefined,
    limit: 1,
    offset: 0,
    include_relationships: true,
    search_tolerance: "normal",
    match_mode: "any",
    relationship_filter: undefined,
  };

  if (db.searchMemoriesPaginated) {
    const result = await db.searchMemoriesPaginated(query);
    return result.total_count;
  }

  let count = 0;
  for await (const batch of paginateMemories(db, 1000)) {
    count += batch.length;
  }
  return count;
}

export async function getAllMemories(db: DBLike): Promise<Memory[]> {
  const all: Memory[] = [];
  for await (const batch of paginateMemories(db, 1000)) {
    all.push(...batch);
  }
  return all;
}
