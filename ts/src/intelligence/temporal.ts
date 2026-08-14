/**
 * Temporal Memory - Track how information changes over time.
 *
 * Port of the Python `memorygraph.intelligence.temporal` module.
 * Handles version tracking, memory history, and temporal queries.
 */

import type { GraphBackend } from "../backends/index.js";

// ---------------------------------------------------------------------------
// Temporal memory
// ---------------------------------------------------------------------------

export interface MemoryVersion {
  id: string;
  title: string | null;
  content: string | null;
  type: string | null;
  tags: string[];
  created_at: string | null;
  updated_at: string | null;
  is_current: boolean;
  superseded_by: string | null;
  version_depth: number;
}

export interface MemoryState {
  id: string;
  title: string | null;
  content: string | null;
  type: string | null;
  tags: string[];
  created_at: string | null;
  updated_at: string | null;
  is_current: boolean;
  queried_at: Date;
}

export interface EntityChange {
  memory_id: string;
  title: string | null;
  content: string | null;
  memory_type: string | null;
  created_at: string | null;
  updated_at: string | null;
  mention_confidence: number | null;
  was_new_mention: boolean;
  status: string;
}

export interface VersionDiff {
  title?: { from: string | null; to: string | null };
  content?: { from: string | null; to: string | null };
  type?: { from: string | null; to: string | null };
  tags?: { added: string[]; removed: string[] };
}

export class TemporalMemory {
  backend: GraphBackend;

  constructor(backend: GraphBackend) {
    this.backend = backend;
  }

  /**
   * Get complete version history for a memory by traversing PREVIOUS
   * relationships.
   *
   * @returns Memory versions in chronological order (oldest to newest)
   */
  async getMemoryHistory(memoryId: string): Promise<MemoryVersion[]> {
    const query = `
      MATCH path = (current:Memory {id: $memory_id})-[:PREVIOUS*0..]->(older:Memory)
      WITH older, length(path) as depth
      ORDER BY depth DESC
      RETURN older.id as id,
             older.title as title,
             older.content as content,
             older.type as type,
             older.tags as tags,
             older.created_at as created_at,
             older.updated_at as updated_at,
             older.is_current as is_current,
             older.superseded_by as superseded_by,
             depth
    `;

    const params = { memory_id: memoryId };

    try {
      const results = await this.backend.executeQuery(query, params, false);
      const history: MemoryVersion[] = [];

      for (const record of results) {
        history.push({
          id: String(record["id"] ?? ""),
          title: (record["title"] as string | null | undefined) ?? null,
          content: (record["content"] as string | null | undefined) ?? null,
          type: (record["type"] as string | null | undefined) ?? null,
          tags: (record["tags"] as string[] | undefined) ?? [],
          created_at: (record["created_at"] as string | null | undefined) ?? null,
          updated_at: (record["updated_at"] as string | null | undefined) ?? null,
          is_current: Boolean(record["is_current"] ?? true),
          superseded_by: (record["superseded_by"] as string | null | undefined) ?? null,
          version_depth: Number(record["depth"] ?? 0),
        });
      }

      return history;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error getting memory history for ${memoryId}: ${message}`);
      return [];
    }
  }

  /**
   * Get the state of a memory at a specific point in time.
   *
   * @param memoryId - ID of the memory
   * @param timestamp - Target timestamp
   * @returns Memory state at that timestamp, or null if not found
   */
  async getStateAt(memoryId: string, timestamp: Date): Promise<MemoryState | null> {
    const query = `
      MATCH path = (current:Memory {id: $memory_id})-[:PREVIOUS*0..]->(older:Memory)
      WHERE older.created_at <= $timestamp
      WITH older, length(path) as depth
      ORDER BY depth ASC, older.created_at DESC
      LIMIT 1
      RETURN older.id as id,
             older.title as title,
             older.content as content,
             older.type as type,
             older.tags as tags,
             older.created_at as created_at,
             older.updated_at as updated_at,
             older.is_current as is_current
    `;

    const params = { memory_id: memoryId, timestamp: timestamp.toISOString() };

    try {
      const results = await this.backend.executeQuery(query, params, false);
      if (results.length === 0) return null;

      const record = results[0];
      return {
        id: String(record["id"] ?? ""),
        title: (record["title"] as string | null | undefined) ?? null,
        content: (record["content"] as string | null | undefined) ?? null,
        type: (record["type"] as string | null | undefined) ?? null,
        tags: (record["tags"] as string[] | undefined) ?? [],
        created_at: (record["created_at"] as string | null | undefined) ?? null,
        updated_at: (record["updated_at"] as string | null | undefined) ?? null,
        is_current: Boolean(record["is_current"] ?? false),
        queried_at: timestamp,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `Error getting state at ${timestamp.toISOString()} for ${memoryId}: ${message}`
      );
      return null;
    }
  }

  /**
   * Track how an entity has changed over time by finding all memories that
   * mention it.
   */
  async trackEntityChanges(entityId: string): Promise<EntityChange[]> {
    const query = `
      MATCH (e:Entity)
      WHERE e.id = $entity_id OR e.text = $entity_id
      MATCH (m:Memory)-[r:MENTIONS]->(e)
      OPTIONAL MATCH (m)-[:PREVIOUS]->(prev:Memory)
      WITH m, e, prev,
           CASE WHEN prev IS NOT NULL
                THEN exists((prev)-[:MENTIONS]->(e))
                ELSE false
           END as was_mentioned_before
      RETURN m.id as memory_id,
             m.title as title,
             m.content as content,
             m.type as memory_type,
             m.created_at as created_at,
             m.updated_at as updated_at,
             r.confidence as mention_confidence,
             was_mentioned_before,
             CASE WHEN m.is_current = true THEN 'current'
                  WHEN m.superseded_by IS NOT NULL THEN 'superseded'
                  ELSE 'active'
             END as status
      ORDER BY m.created_at ASC
    `;

    const params = { entity_id: entityId };

    try {
      const results = await this.backend.executeQuery(query, params, false);
      const timeline: EntityChange[] = [];

      for (const record of results) {
        timeline.push({
          memory_id: String(record["memory_id"] ?? ""),
          title: (record["title"] as string | null | undefined) ?? null,
          content: (record["content"] as string | null | undefined) ?? null,
          memory_type: (record["memory_type"] as string | null | undefined) ?? null,
          created_at: (record["created_at"] as string | null | undefined) ?? null,
          updated_at: (record["updated_at"] as string | null | undefined) ?? null,
          mention_confidence:
            record["mention_confidence"] === null || record["mention_confidence"] === undefined
              ? null
              : Number(record["mention_confidence"]),
          was_new_mention: !Boolean(record["was_mentioned_before"] ?? false),
          status: String(record["status"] ?? "active"),
        });
      }

      return timeline;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error tracking entity changes for ${entityId}: ${message}`);
      return [];
    }
  }

  /**
   * Create a new version of a memory, linking it to the previous version.
   *
   * @param currentMemoryId - ID of the current memory to supersede
   * @param newMemory - New memory data
   * @returns ID of the new memory version
   */
  async createVersion(
    currentMemoryId: string,
    newMemory: Record<string, unknown>
  ): Promise<string> {
    const query = `
      MATCH (current:Memory {id: $current_id})
      CREATE (new:Memory)
      SET new = $new_props,
          new.id = randomUUID(),
          new.created_at = $now,
          new.updated_at = $now,
          new.is_current = true,
          current.is_current = false,
          current.superseded_by = new.id
      CREATE (new)-[:PREVIOUS {superseded_at: $now}]->(current)
      RETURN new.id as new_id
    `;

    const now = new Date().toISOString();
    const params = { current_id: currentMemoryId, new_props: newMemory, now };

    try {
      const results = await this.backend.executeQuery(query, params, true);
      if (results.length === 0) {
        throw new Error("Failed to create new version");
      }
      const newId = String(results[0]["new_id"] ?? "");
      console.log(`Created new version ${newId} for memory ${currentMemoryId}`);
      return newId;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error creating version for ${currentMemoryId}: ${message}`);
      throw e;
    }
  }

  /**
   * Compare two versions of a memory and return differences.
   */
  async getVersionDiff(version1Id: string, version2Id: string): Promise<VersionDiff> {
    const query = `
      MATCH (v1:Memory {id: $v1_id})
      MATCH (v2:Memory {id: $v2_id})
      RETURN v1.title as v1_title, v2.title as v2_title,
             v1.content as v1_content, v2.content as v2_content,
             v1.type as v1_type, v2.type as v2_type,
             v1.tags as v1_tags, v2.tags as v2_tags,
             v1.updated_at as v1_updated, v2.updated_at as v2_updated
    `;

    const params = { v1_id: version1Id, v2_id: version2Id };

    try {
      const results = await this.backend.executeQuery(query, params, false);
      if (results.length === 0) return {};

      const record = results[0];
      const diff: VersionDiff = {};

      const v1Title = (record["v1_title"] as string | null | undefined) ?? null;
      const v2Title = (record["v2_title"] as string | null | undefined) ?? null;
      if (v1Title !== v2Title) {
        diff.title = { from: v1Title, to: v2Title };
      }

      const v1Content = (record["v1_content"] as string | null | undefined) ?? null;
      const v2Content = (record["v2_content"] as string | null | undefined) ?? null;
      if (v1Content !== v2Content) {
        diff.content = { from: v1Content, to: v2Content };
      }

      const v1Type = (record["v1_type"] as string | null | undefined) ?? null;
      const v2Type = (record["v2_type"] as string | null | undefined) ?? null;
      if (v1Type !== v2Type) {
        diff.type = { from: v1Type, to: v2Type };
      }

      const v1Tags = new Set((record["v1_tags"] as string[] | undefined) ?? []);
      const v2Tags = new Set((record["v2_tags"] as string[] | undefined) ?? []);
      if (!setsEqual(v1Tags, v2Tags)) {
        const added: string[] = [];
        const removed: string[] = [];
        for (const t of v2Tags) if (!v1Tags.has(t)) added.push(t);
        for (const t of v1Tags) if (!v2Tags.has(t)) removed.push(t);
        diff.tags = { added, removed };
      }

      return diff;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `Error comparing versions ${version1Id} and ${version2Id}: ${message}`
      );
      return {};
    }
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

export async function getMemoryHistory(
  backend: GraphBackend,
  memoryId: string
): Promise<MemoryVersion[]> {
  const temporal = new TemporalMemory(backend);
  return temporal.getMemoryHistory(memoryId);
}

export async function getStateAt(
  backend: GraphBackend,
  memoryId: string,
  timestamp: Date
): Promise<MemoryState | null> {
  const temporal = new TemporalMemory(backend);
  return temporal.getStateAt(memoryId, timestamp);
}

export async function trackEntityChanges(
  backend: GraphBackend,
  entityId: string
): Promise<EntityChange[]> {
  const temporal = new TemporalMemory(backend);
  return temporal.trackEntityChanges(entityId);
}
