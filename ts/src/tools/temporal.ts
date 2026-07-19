/**
 * Temporal tool handlers for bi-temporal queries.
 *
 * - query_as_of: Query relationships as they existed at a specific time
 * - get_relationship_history: Get full history of relationships for a memory
 * - what_changed: Show relationship changes since a specific time
 */

import type { IMemoryDatabase } from "../database.js";
import type { Memory, Relationship } from "../models.js";
import { handleToolErrors, neverThrowBoundary } from "./error-handling.js";

export interface QueryAsOfArgs {
  memory_id: string;
  as_of: string;
  relationship_types?: string[];
}

export interface GetRelationshipHistoryArgs {
  memory_id: string;
  relationship_types?: string[];
}

export interface WhatChangedArgs {
  since: string;
}

export const handleQueryAsOf = neverThrowBoundary(
  "query as of",
  handleToolErrors(
    "query as of",
    async (db: IMemoryDatabase, args: QueryAsOfArgs): Promise<string> => {
    const memoryId = args["memory_id"];
    const asOfStr = args["as_of"];

    const memory = await db.getMemory(memoryId);
    if (!memory) {
      return `Memory not found: ${memoryId}`;
    }

    let asOf: Date;
    try {
      asOf = new Date(asOfStr.replace("Z", "+00:00"));
      if (isNaN(asOf.getTime())) throw new Error("Invalid date");
    } catch {
      return `Invalid timestamp format. Expected ISO 8601 (e.g., '2024-12-01T00:00:00Z'), got: ${asOfStr}`;
    }

    // Query as of the specified time - filter by valid_from/valid_until
    const related = await db.getRelatedMemories(memoryId, {
      relationshipTypes: args["relationship_types"],
      maxDepth: 2,
    });

    // Filter relationships that were valid at the specified time
    const validAtTime = related.filter(([, rel]) => {
      const validFrom = new Date(rel.properties.valid_from);
      const validUntil = rel.properties.valid_until
        ? new Date(rel.properties.valid_until)
        : null;
      return validFrom <= asOf && (!validUntil || validUntil > asOf);
    });

    if (validAtTime.length === 0) {
      return `No relationships found for memory '${memoryId}' as of ${asOfStr}`;
    }

    let text = `**Relationships as of ${asOfStr}** (${validAtTime.length} found):\n\n`;
    for (let i = 0; i < validAtTime.length; i++) {
      const [mem, rel] = validAtTime[i];
      text += `**${i + 1}. ${mem.title}** (ID: ${mem.id})\n`;
      text += `Relationship: ${rel.type} (strength: ${rel.properties.strength})\n`;
      text += `Valid from: ${toIso(rel.properties.valid_from)}\n`;
      text += `Valid until: ${rel.properties.valid_until ? toIso(rel.properties.valid_until) : "current"}\n`;
      text += `Type: ${mem.type} | Importance: ${mem.importance}\n\n`;
    }

    return text;
  }
  )
);

export const handleGetRelationshipHistory = neverThrowBoundary(
  "get relationship history",
  handleToolErrors(
    "get relationship history",
    async (db: IMemoryDatabase, args: GetRelationshipHistoryArgs): Promise<string> => {
    const memoryId = args["memory_id"];

    const memory = await db.getMemory(memoryId);
    if (!memory) {
      return `Memory not found: ${memoryId}`;
    }

    // Get all related memories (including invalidated ones)
    const history = await db.getRelatedMemories(memoryId, {
      relationshipTypes: args["relationship_types"],
      maxDepth: 2,
    });

    if (history.length === 0) {
      return `No relationship history found for memory: ${memoryId}`;
    }

    const current = history.filter(([, rel]) => !rel.properties.valid_until);
    const invalidated = history.filter(([, rel]) => rel.properties.valid_until);

    let text = `**Relationship History for ${memoryId}** (${history.length} relationships):\n\n`;

    if (current.length > 0) {
      text += "## Current Relationships:\n\n";
      for (let i = 0; i < current.length; i++) {
        const [mem, rel] = current[i];
        text += `**${i + 1}. ${rel.type}**\n`;
        text += `From: ${rel.from_memory_id} -> To: ${rel.to_memory_id}\n`;
        text += `Valid from: ${toIso(rel.properties.valid_from)}\n`;
        text += `Strength: ${rel.properties.strength} | Confidence: ${rel.properties.confidence}\n`;
        if (rel.properties.context) {
          try {
            const context = JSON.parse(rel.properties.context);
            if (context["text"]) text += `Context: ${context["text"]}\n`;
          } catch {
            // skip malformed context
          }
        }
        text += "\n";
      }
    }

    if (invalidated.length > 0) {
      text += "## Historical (Invalidated) Relationships:\n\n";
      for (let i = 0; i < invalidated.length; i++) {
        const [, rel] = invalidated[i];
        text += `**${i + 1}. ${rel.type}**\n`;
        text += `From: ${rel.from_memory_id} -> To: ${rel.to_memory_id}\n`;
        text += `Valid from: ${toIso(rel.properties.valid_from)}\n`;
        text += `Valid until: ${toIso(rel.properties.valid_until!)}\n`;
        if (rel.properties.invalidated_by) {
          text += `Superseded by: ${rel.properties.invalidated_by}\n`;
        }
        text += `Strength: ${rel.properties.strength}\n\n`;
      }
    }

    return text;
  }
  )
);

export const handleWhatChanged = neverThrowBoundary(
  "get what changed",
  handleToolErrors(
    "get what changed",
    async (db: IMemoryDatabase, args: WhatChangedArgs): Promise<string> => {
    const sinceStr = args["since"];

    let since: Date;
    try {
      since = new Date(sinceStr.replace("Z", "+00:00"));
      if (isNaN(since.getTime())) throw new Error("Invalid date");
    } catch {
      return `Invalid timestamp format. Expected ISO 8601 (e.g., '2024-12-01T00:00:00Z'), got: ${sinceStr}`;
    }

    // Get all memories and their relationships, filter by recorded_at
    const allMemories = await db.searchMemories({
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
      limit: 1000,
      offset: 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    });

    const newRelationships: Relationship[] = [];
    const invalidatedRelationships: Relationship[] = [];
    const seenRelIds = new Set<string>();

    for (const mem of allMemories) {
      if (!mem.id) continue;
      try {
        const related = await db.getRelatedMemories(mem.id, { maxDepth: 1 });
        for (const [, rel] of related) {
          const relId = rel.id ?? `${rel.from_memory_id}-${rel.to_memory_id}-${rel.type}`;
          if (seenRelIds.has(relId)) continue;
          seenRelIds.add(relId);

          const recordedAt = new Date(rel.properties.recorded_at);
          if (recordedAt >= since) {
            newRelationships.push(rel);
          }

          if (rel.properties.valid_until) {
            const validUntil = new Date(rel.properties.valid_until);
            if (validUntil >= since) {
              invalidatedRelationships.push(rel);
            }
          }
        }
      } catch {
        // skip memories with errors
      }
    }

    if (newRelationships.length === 0 && invalidatedRelationships.length === 0) {
      return `No relationship changes found since ${sinceStr}`;
    }

    let text = `**Changes since ${sinceStr}**:\n\n`;

    if (newRelationships.length > 0) {
      text += `## New Relationships (${newRelationships.length}):\n\n`;
      for (let i = 0; i < newRelationships.length; i++) {
        const rel = newRelationships[i];
        text += `**${i + 1}. ${rel.type}**\n`;
        text += `From: ${rel.from_memory_id} -> To: ${rel.to_memory_id}\n`;
        text += `Recorded at: ${toIso(rel.properties.recorded_at)}\n`;
        text += `Strength: ${rel.properties.strength}\n`;
        if (rel.properties.context) {
          try {
            const context = JSON.parse(rel.properties.context);
            if (context["text"]) text += `Context: ${context["text"]}\n`;
          } catch {
            // skip
          }
        }
        text += "\n";
      }
    }

    if (invalidatedRelationships.length > 0) {
      text += `## Invalidated Relationships (${invalidatedRelationships.length}):\n\n`;
      for (let i = 0; i < invalidatedRelationships.length; i++) {
        const rel = invalidatedRelationships[i];
        text += `**${i + 1}. ${rel.type}**\n`;
        text += `From: ${rel.from_memory_id} -> To: ${rel.to_memory_id}\n`;
        text += `Invalidated at: ${toIso(rel.properties.valid_until!)}\n`;
        if (rel.properties.invalidated_by) {
          text += `Superseded by: ${rel.properties.invalidated_by}\n`;
        }
        text += "\n";
      }
    }

    return text;
  }
  )
);

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
