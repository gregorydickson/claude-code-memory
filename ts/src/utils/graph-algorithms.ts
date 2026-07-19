/**
 * Graph algorithm utilities for MemoryGraph.
 *
 * Provides cycle detection, path finding, and other graph operations
 * on memory relationships.
 */

import type { RelationshipType } from "../models.ts";

export interface MemoryDBLike {
  getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[import("../models.ts").Memory, import("../models.ts").Relationship][]>;
}

/**
 * Check if adding a relationship would create a cycle in the graph.
 *
 * Uses DFS to traverse from to_memory_id and check if from_memory_id is reachable.
 */
export async function hasCycle(
  memoryDb: MemoryDBLike,
  fromMemoryId: string,
  toMemoryId: string,
  relationshipType: string,
  maxDepth = 100
): Promise<boolean> {
  if (fromMemoryId === toMemoryId) return true;

  const visited = new Set<string>();

  async function dfs(currentId: string, depth: number): Promise<boolean> {
    if (depth > maxDepth) return false;
    if (visited.has(currentId)) return false;
    if (currentId === fromMemoryId) return true;

    visited.add(currentId);

    try {
      const related = await memoryDb.getRelatedMemories(currentId, {
        relationshipTypes: [relationshipType],
        maxDepth: 1,
      });

      for (const [, rel] of related) {
        const targetId = rel.from_memory_id === currentId ? rel.to_memory_id : rel.from_memory_id;
        if (await dfs(targetId, depth + 1)) return true;
      }
    } catch (err) {
      console.error(`Error during cycle detection DFS: ${err}`);
    }

    return false;
  }

  return dfs(toMemoryId, 0);
}
