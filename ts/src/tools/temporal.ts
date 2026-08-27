/**
 * Temporal tool handlers for bi-temporal queries.
 *
 * - query_as_of: Query relationships as they existed at a specific time
 * - get_relationship_history: Get full history of relationships for a memory
 * - what_changed: Show relationship changes since a specific time
 */

import type { IMemoryDatabase } from "../database.ts";
import type { Memory, Relationship } from "../models.ts";
import { handleToolErrors, neverThrowBoundary } from "./error-handling.ts";

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

    // H7 (VAL-LOCAL-017): surface the memory's STATE at `as_of` in
    // addition to the relationships valid at that time. Backends with
    // minimal versioning (falkordblite, falkordb) reconstruct the
    // pre-update content via `:MemoryVersion` snapshots; backends
    // without versioning (sqlite, cloud) return the current state as a
    // fallback. This makes `as-of` genuinely return "the memory's state
    // at that time" rather than only the relationship picture.
    let stateText = "";
    if (db.getMemoryStateAt) {
      try {
        const historicalState = await db.getMemoryStateAt(memoryId, asOf);
        if (historicalState) {
          stateText = `## Memory State as of ${asOfStr}\n\n`;
          stateText += `**Title:** ${historicalState.title}\n`;
          stateText += `**Type:** ${historicalState.type}\n`;
          stateText += `**Content:** ${historicalState.content}\n`;
          if (historicalState.summary) stateText += `**Summary:** ${historicalState.summary}\n`;
          if (historicalState.tags && historicalState.tags.length > 0) {
            stateText += `**Tags:** ${historicalState.tags.join(", ")}\n`;
          }
          stateText += `**Importance:** ${historicalState.importance}\n`;
          stateText += `\n`;
        }
      } catch {
        // Versioning query failed — fall through to relationship-only output.
      }
    }

    // Query as of the specified time - filter by valid_from/valid_until.
    // VAL-REVIEW-012: lift the interactive LIMIT 20 so as-of analysis sees
    // every relationship, including invalidated historical edges.
    const related = await db.getRelatedMemories(memoryId, {
      relationshipTypes: args["relationship_types"],
      maxDepth: 2,
      limit: 10000,
    });

    // Filter relationships that were valid at the specified time
    const validAtTime = related.filter(([, rel]) => {
      const validFrom = new Date(rel.properties.valid_from);
      const validUntil = rel.properties.valid_until
        ? new Date(rel.properties.valid_until)
        : null;
      return validFrom <= asOf && (!validUntil || validUntil > asOf);
    });

    let text = stateText;

    if (validAtTime.length === 0) {
      text += `No relationships found for memory '${memoryId}' as of ${asOfStr}`;
    } else {
      text += `**Relationships as of ${asOfStr}** (${validAtTime.length} found):\n\n`;
      for (let i = 0; i < validAtTime.length; i++) {
        const [mem, rel] = validAtTime[i];
        text += `**${i + 1}. ${mem.title}** (ID: ${mem.id})\n`;
        text += `Relationship: ${rel.type} (strength: ${rel.properties.strength})\n`;
        text += `Valid from: ${toIso(rel.properties.valid_from)}\n`;
        text += `Valid until: ${rel.properties.valid_until ? toIso(rel.properties.valid_until) : "current"}\n`;
        text += `Type: ${mem.type} | Importance: ${mem.importance}\n\n`;
      }
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

    // H7 (VAL-LOCAL-018): include the memory's VERSION history (from
    // `:MemoryVersion` snapshots) alongside the relationship history.
    // Backends with minimal versioning (falkordblite, falkordb) return the
    // full version chain; backends without versioning (sqlite, cloud)
    // return a single-element list with the current state.
    let versionText = "";
    if (db.getMemoryVersions) {
      try {
        const versions = await db.getMemoryVersions(memoryId);
        if (versions.length > 0) {
          versionText = `## Version History (${versions.length} versions):\n\n`;
          for (let i = 0; i < versions.length; i++) {
            const v = versions[i];
            const updated = v.updated_at instanceof Date ? v.updated_at.toISOString() : (v.updated_at ?? "");
            versionText += `**${i + 1}. ${v.title ?? "Untitled"}**\n`;
            versionText += `Type: ${v.type ?? "unknown"} | Version: ${v.version ?? 1}\n`;
            versionText += `Updated: ${toIso(updated)}\n`;
            if (v.content) {
              const snippet = v.content.slice(0, 200);
              versionText += `Content: ${snippet}${v.content.length > 200 ? "..." : ""}\n`;
            }
            if (v.tags && v.tags.length > 0) {
              versionText += `Tags: ${v.tags.join(", ")}\n`;
            }
            versionText += `\n`;
          }
        }
      } catch {
        // Version query failed — fall through to relationship-only history.
      }
    }

    // Get all related memories (including invalidated ones).
    // VAL-REVIEW-012: lift the interactive LIMIT 20 for history.
    const history = await db.getRelatedMemories(memoryId, {
      relationshipTypes: args["relationship_types"],
      maxDepth: 2,
      limit: 10000,
    });

    let text = `**Relationship History for ${memoryId}** (${history.length} relationships):\n\n`;

    if (versionText) {
      text += versionText;
    }

    if (history.length === 0) {
      text += `No relationship history found for memory: ${memoryId}`;
      return text;
    }

    const current = history.filter(([, rel]) => !rel.properties.valid_until);
    const invalidated = history.filter(([, rel]) => rel.properties.valid_until);

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

    // M12 (VAL-LOCAL-014): issue a SINGLE backend query filtering
    // relationships by `recorded_at >= $since`. The previous implementation
    // searched memories with `searchMemories({limit: 1000})` then called
    // `getRelatedMemories` per memory (N+1) — both the implicit 1000-cap and
    // the N+1 fan-out silently truncated / scaled badly. The new path
    // returns the full matching set with no truncation.
    const allRelationships = db.getRelationshipsSince
      ? await db.getRelationshipsSince(since)
      : [];

    const newRelationships: Relationship[] = [];
    const invalidatedRelationships: Relationship[] = [];
    const seenRelIds = new Set<string>();

    for (const rel of allRelationships) {
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
