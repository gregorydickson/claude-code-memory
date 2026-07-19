/**
 * Activity and statistics tool handlers for the CLI.
 *
 * get_recent_activity, get_memory_statistics, search_relationships_by_context
 */

import type { IMemoryDatabase } from "../database.js";
import type { Memory } from "../models.js";
import { detectProjectContext } from "../utils/project-detection.js";
import { handleToolErrors, neverThrowBoundary } from "./error-handling.js";

function getMemoryAttr(memory: Memory | Record<string, unknown>, attr: string, defaultVal?: unknown): unknown {
  if (typeof memory === "object" && memory !== null && attr in memory) {
    return (memory as Record<string, unknown>)[attr];
  }
  return defaultVal;
}

const _handleGetMemoryStatistics = handleToolErrors(
  "get memory statistics",
  async (db: IMemoryDatabase, _args: Record<string, unknown>): Promise<string> => {
    const stats = await db.getMemoryStatistics();

    let text = "**Memory Database Statistics**\n\n";

    const totalMemories = stats["total_memories"] as Record<string, unknown> | undefined;
    if (totalMemories) {
      text += `Total Memories: ${totalMemories["count"]}\n`;
    }

    const byType = stats["memories_by_type"] as Record<string, number> | undefined;
    if (byType) {
      text += "\n**Memories by Type:**\n";
      for (const [memType, count] of Object.entries(byType)) {
        text += `- ${memType}: ${count}\n`;
      }
    }

    const totalRels = stats["total_relationships"] as Record<string, unknown> | undefined;
    if (totalRels) {
      text += `\nTotal Relationships: ${totalRels["count"]}\n`;
    }

    const avgImp = stats["avg_importance"] as Record<string, number> | undefined;
    if (avgImp) {
      text += `Average Importance: ${avgImp["avg_importance"]?.toFixed(2)}\n`;
    }

    const avgConf = stats["avg_confidence"] as Record<string, number> | undefined;
    if (avgConf) {
      text += `Average Confidence: ${avgConf["avg_confidence"]?.toFixed(2)}\n`;
    }

    return text;
  }
);
export const handleGetMemoryStatistics = neverThrowBoundary("get memory statistics", _handleGetMemoryStatistics);

const _handleGetRecentActivity = handleToolErrors(
  "get recent activity",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    if (!db.getRecentActivity) {
      return "Recent activity summary is not supported by this backend";
    }

    const days = (args["days"] as number) ?? 7;
    let project = (args["project"] as string) ?? undefined;

    if (!project) {
      const projectInfo = detectProjectContext();
      if (projectInfo) {
        project = projectInfo.project_path;
      }
    }

    const activity = await db.getRecentActivity(days, project ?? null);

    let text = `**Recent Activity Summary (Last ${days} days)**\n\n`;
    if (project) text += `**Project**: ${project}\n\n`;

    text += `**Total Memories**: ${activity["total_count"]}\n\n`;

    const byType = activity["memories_by_type"] as Record<string, number> | undefined;
    if (byType) {
      text += "**Breakdown by Type**:\n";
      const sorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
      for (const [memType, count] of sorted) {
        text += `- ${memType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}: ${count}\n`;
      }
      text += "\n";
    }

    const unresolved = activity["unresolved_problems"] as Memory[] | undefined;
    if (unresolved && unresolved.length > 0) {
      text += `**Unresolved Problems (${unresolved.length})**:\n`;
      for (const problem of unresolved) {
        const title = getMemoryAttr(problem, "title", "Unknown");
        const importance = getMemoryAttr(problem, "importance", 0.5) as number;
        const summary = getMemoryAttr(problem, "summary") as string | undefined;
        text += `- **${title}** (importance: ${importance.toFixed(1)})\n`;
        if (summary) text += `  ${summary}\n`;
      }
      text += "\n";
    }

    const recent = activity["recent_memories"] as Memory[] | undefined;
    if (recent && recent.length > 0) {
      text += `**Recent Memories** (showing ${Math.min(10, recent.length)}):\n`;
      for (let i = 0; i < Math.min(10, recent.length); i++) {
        const mem = recent[i];
        const title = getMemoryAttr(mem, "title", "Unknown");
        const type = getMemoryAttr(mem, "type", "general");
        const summary = getMemoryAttr(mem, "summary") as string | undefined;
        text += `${i + 1}. **${title}** (${type})\n`;
        if (summary) text += `   ${summary}\n`;
      }
      text += "\n";
    }

    text += "**Next Steps**:\n";
    if (unresolved && unresolved.length > 0) {
      text += "- Review unresolved problems and consider solutions\n";
      text += `- Use 'memorygraph get <id>' for details\n`;
    } else {
      text += "- All problems have been addressed!\n";
    }

    return text;
  }
);
export const handleGetRecentActivity = neverThrowBoundary("get recent activity", _handleGetRecentActivity);

const _handleSearchRelationshipsByContext = handleToolErrors(
  "search relationships by context",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    const memoryId = args["memory_id"] as string | undefined;
    const relationshipTypes = (args["relationship_types"] as string[]) ?? [];
    const minStrength = (args["min_strength"] as number) ?? undefined;
    const contextQuery = (args["context_query"] as string) ?? undefined;
    const limit = (args["limit"] as number) ?? 20;

    if (!memoryId) {
      return "Error: 'memory_id' parameter is required";
    }

    const memory = await db.getMemory(memoryId);
    if (!memory) {
      return `Memory not found: ${memoryId}`;
    }

    const related = await db.getRelatedMemories(memoryId, {
      relationshipTypes: relationshipTypes.length > 0 ? relationshipTypes : undefined,
      maxDepth: 2,
    });

    let filtered = related;

    if (minStrength !== undefined) {
      filtered = filtered.filter(([, rel]) => rel.properties.strength >= minStrength);
    }

    if (contextQuery) {
      const lowerQuery = contextQuery.toLowerCase();
      filtered = filtered.filter(([, rel]) => {
        if (rel.properties.context) {
          try {
            const ctx = JSON.parse(rel.properties.context);
            const ctxText = (ctx["text"] as string) ?? "";
            return ctxText.toLowerCase().includes(lowerQuery);
          } catch {
            return rel.properties.context.toLowerCase().includes(lowerQuery);
          }
        }
        return false;
      });
    }

    filtered = filtered.slice(0, limit);

    if (filtered.length === 0) {
      let msg = `No relationships found for memory '${memoryId}'`;
      if (relationshipTypes.length > 0) msg += ` with types: ${relationshipTypes.join(", ")}`;
      if (minStrength !== undefined) msg += ` and strength >= ${minStrength}`;
      if (contextQuery) msg += ` matching context '${contextQuery}'`;
      return msg;
    }

    let text = `**Relationships for '${memory.title}'** (${filtered.length} found):\n\n`;
    for (let i = 0; i < filtered.length; i++) {
      const [mem, rel] = filtered[i];
      text += `**${i + 1}. ${mem.title}** (ID: ${mem.id})\n`;
      text += `Relationship: ${rel.type} (strength: ${rel.properties.strength}, confidence: ${rel.properties.confidence})\n`;
      text += `Type: ${mem.type} | Importance: ${mem.importance}\n`;
      if (rel.properties.context) {
        try {
          const ctx = JSON.parse(rel.properties.context);
          if (ctx["text"]) text += `Context: ${ctx["text"]}\n`;
        } catch {
          text += `Context: ${rel.properties.context}\n`;
        }
      }
      text += "\n";
    }

    return text;
  }
);
export const handleSearchRelationshipsByContext = neverThrowBoundary(
  "search relationships by context",
  _handleSearchRelationshipsByContext
);
