/**
 * Search tool handlers for the CLI.
 *
 * search_memories, recall_memories, contextual_search
 */

import type { IMemoryDatabase } from "../database.js";
import type { SearchQuery, Memory } from "../models.js";
import { validateSearchInput } from "../utils/validation.js";
import { handleToolErrors, neverThrowBoundary } from "./error-handling.js";

const _handleSearchMemories = handleToolErrors(
  "search memories",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    validateSearchInput(args);

    const searchQuery: SearchQuery = {
      query: (args["query"] as string) ?? undefined,
      terms: (args["terms"] as string[]) ?? [],
      memory_types: (args["memory_types"] as string[]) ?? [],
      tags: (args["tags"] as string[]) ?? [],
      project_path: (args["project_path"] as string) ?? undefined,
      languages: [],
      frameworks: [],
      min_importance: (args["min_importance"] as number) ?? undefined,
      min_confidence: (args["min_confidence"] as number) ?? undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: (args["limit"] as number) ?? 50,
      offset: (args["offset"] as number) ?? 0,
      include_relationships: true,
      search_tolerance: ((args["search_tolerance"] as string) ?? "normal") as "strict" | "normal" | "fuzzy",
      match_mode: ((args["match_mode"] as string) ?? "any") as "any" | "all",
      relationship_filter: (args["relationship_filter"] as string[]) ?? undefined,
    };

    const memories = await db.searchMemories(searchQuery);
    if (memories.length === 0) {
      return "No memories found matching the search criteria.";
    }

    let text = `Found ${memories.length} memories:\n\n`;
    for (let i = 0; i < memories.length; i++) {
      const mem = memories[i];
      text += `**${i + 1}. ${mem.title}** (ID: ${mem.id})\n`;
      text += `Type: ${mem.type} | Importance: ${mem.importance}\n`;
      text += `Tags: ${mem.tags.length > 0 ? mem.tags.join(", ") : "None"}\n`;
      if (mem.summary) text += `Summary: ${mem.summary}\n`;
      text += "\n";
    }

    return text;
  }
);
export const handleSearchMemories = neverThrowBoundary("search memories", _handleSearchMemories);

const _handleRecallMemories = handleToolErrors(
  "recall memories",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    validateSearchInput(args);

    const searchQuery: SearchQuery = {
      query: (args["query"] as string) ?? undefined,
      terms: [],
      memory_types: (args["memory_types"] as string[]) ?? [],
      tags: [],
      project_path: (args["project_path"] as string) ?? undefined,
      languages: [],
      frameworks: [],
      min_importance: undefined,
      min_confidence: undefined,
      min_effectiveness: undefined,
      created_after: undefined,
      created_before: undefined,
      limit: (args["limit"] as number) ?? 20,
      offset: (args["offset"] as number) ?? 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    };

    const memories = await db.searchMemories(searchQuery);
    if (memories.length === 0) {
      return "No memories found matching your query. Try:\n- Using different search terms\n- Removing filters to broaden the search\n- Checking if memories have been stored for this topic";
    }

    let text = `**Found ${memories.length} relevant memories:**\n\n`;
    for (let i = 0; i < memories.length; i++) {
      const mem = memories[i];
      text += `**${i + 1}. ${mem.title}** (ID: ${mem.id})\n`;
      text += `Type: ${mem.type} | Importance: ${mem.importance}\n`;

      if (mem.match_info) {
        const matchInfo = mem.match_info as Record<string, unknown>;
        const quality = matchInfo["match_quality"] ?? "unknown";
        const matchedFields = matchInfo["matched_fields"] as string[];
        text += `Match: ${quality} quality`;
        if (Array.isArray(matchedFields) && matchedFields.length > 0) {
          text += ` (in ${matchedFields.join(", ")})`;
        }
        text += "\n";
      }

      if (mem.context_summary) {
        text += `Context: ${mem.context_summary}\n`;
      }

      if (mem.summary) {
        text += `Summary: ${mem.summary}\n`;
      } else if (mem.content) {
        const snippet = mem.content.slice(0, 150);
        text += `Content: ${snippet}${mem.content.length > 150 ? "..." : ""}\n`;
      }

      if (mem.tags.length > 0) {
        text += `Tags: ${mem.tags.join(", ")}\n`;
      }

      if (mem.relationships) {
        const relSummary: string[] = [];
        for (const [relType, relatedIds] of Object.entries(mem.relationships)) {
          if (Array.isArray(relatedIds) && relatedIds.length > 0) {
            relSummary.push(`${relType}: ${relatedIds.length} memories`);
          }
        }
        if (relSummary.length > 0) {
          text += `Relationships: ${relSummary.join(", ")}\n`;
        }
      }

      text += "\n";
    }

    text += "\nNext steps:\n";
    text += `- Use 'memorygraph get <id>' to see full details\n`;
    text += `- Use 'memorygraph related <id>' to explore connections\n`;

    return text;
  }
);
export const handleRecallMemories = neverThrowBoundary("recall memories", _handleRecallMemories);

const _handleContextualSearch = handleToolErrors(
  "perform contextual search",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    validateSearchInput(args);

    if (!args["memory_id"]) return "Error: 'memory_id' parameter is required";
    if (!args["query"]) return "Error: 'query' parameter is required";

    const memoryId = args["memory_id"] as string;
    const query = args["query"] as string;
    const maxDepth = (args["max_depth"] as number) ?? 2;

    const related = await db.getRelatedMemories(memoryId, { maxDepth });
    if (related.length === 0) {
      return `No related memories found for context: ${memoryId}`;
    }

    const relatedIds = new Set(related.map(([mem]) => mem.id));

    const searchQuery: SearchQuery = {
      query,
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
      limit: 100,
      offset: 0,
      include_relationships: true,
      search_tolerance: "normal",
      match_mode: "any",
      relationship_filter: undefined,
    };

    const allMatches = await db.searchMemories(searchQuery);
    const contextualMatches = allMatches.filter((mem) => mem.id && relatedIds.has(mem.id));

    if (contextualMatches.length === 0) {
      return `No matches found for '${query}' within the context of ${memoryId}`;
    }

    let text = `**Contextual Search Results:**\n\n`;
    text += `Context: ${memoryId}\n`;
    text += `Query: '${query}'\n`;
    text += `Searched within ${relatedIds.size} related memories\n`;
    text += `Found ${contextualMatches.length} matches:\n\n`;

    for (let i = 0; i < contextualMatches.length; i++) {
      const mem = contextualMatches[i];
      text += `${i + 1}. **${mem.title}** (ID: ${mem.id})\n`;
      text += `   Type: ${mem.type} | Importance: ${mem.importance}\n`;
      if (mem.summary) {
        text += `   Summary: ${mem.summary}\n`;
      } else if (mem.content) {
        const snippet = mem.content.slice(0, 150);
        text += `   Content: ${snippet}${mem.content.length > 150 ? "..." : ""}\n`;
      }
      if (mem.tags.length > 0) text += `   Tags: ${mem.tags.join(", ")}\n`;
      text += "\n";
    }

    return text;
  }
);
export const handleContextualSearch = neverThrowBoundary("perform contextual search", _handleContextualSearch);
