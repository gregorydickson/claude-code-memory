/**
 * Context-Aware Retrieval - Intelligent context retrieval beyond keyword search.
 *
 * Port of the Python `memorygraph.intelligence.context_retrieval` module.
 * Provides smart context assembly, relevance ranking, and token-limited
 * context formatting.
 */

import type { GraphBackend } from "../backends/index.ts";
import { extractEntities } from "./entity-extraction.ts";

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface SourceMemory {
  id: string;
  title: string | null;
  relevance: number;
}

export interface QueryContext {
  context: string;
  source_memories: SourceMemory[];
  total_memories?: number;
  estimated_tokens?: number;
  query_entities?: string[];
  query_keywords?: string[];
  error?: string;
}

export interface ProjectSummary {
  total_memories?: number;
  recent_activity?: Record<string, unknown>[];
  decisions?: Record<string, unknown>[];
  open_problems?: Record<string, unknown>[];
  solutions?: Record<string, unknown>[];
  error?: string;
}

export interface SessionContext {
  recent_memories: Record<string, unknown>[];
  total_count: number;
  time_range_hours: number;
  active_entities: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Stop words (shared with pattern-recognition for consistency)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at",
  "to", "for", "of", "with", "by", "from", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "should", "could", "may",
  "might", "can", "this", "that", "these", "those", "what", "which",
  "who", "when", "where", "why", "how",
]);

// ---------------------------------------------------------------------------
// Context retriever
// ---------------------------------------------------------------------------

export class ContextRetriever {
  backend: GraphBackend;

  constructor(backend: GraphBackend) {
    this.backend = backend;
  }

  /**
   * Get intelligent context for a query with smart ranking and token limiting.
   */
  async getContext(
    query: string,
    maxTokens = 4000,
    project: string | null = null
  ): Promise<QueryContext> {
    // Extract entities from query for matching
    const entities = extractEntities(query);
    const entityTexts = entities.filter((e) => e.confidence > 0.6).map((e) => e.text);

    // Extract keywords for fallback matching
    const keywords = this.extractKeywords(query);

    const searchQuery = `
      // Find memories matching entities or keywords
      MATCH (m:Memory)
      WHERE (
        any(entity IN $entities WHERE
          exists((m)-[:MENTIONS]->(:Entity {text: entity}))
        )
        OR
        any(keyword IN $keywords WHERE
          toLower(m.content) CONTAINS keyword OR
          toLower(m.title) CONTAINS keyword
        )
      )
      WITH m
      WHERE $project IS NULL OR $project IN m.tags

      WITH m,
        size([entity IN $entities WHERE
              exists((m)-[:MENTIONS]->(:Entity {text: entity}))]) as entity_matches,
        size([keyword IN $keywords WHERE
              toLower(m.content) CONTAINS keyword OR
              toLower(m.title) CONTAINS keyword]) as keyword_matches,
        duration.between(m.created_at, datetime()).days as age_days

      WITH m, entity_matches, keyword_matches, age_days,
        toFloat(entity_matches * 3 + keyword_matches * 2) /
        (1.0 + age_days / 30.0) as relevance_score

      OPTIONAL MATCH (m)-[r]->(related:Memory)
      WHERE type(r) IN ['SOLVES', 'BUILDS_ON', 'REQUIRES', 'RELATED_TO']
      WITH m, relevance_score,
        collect(DISTINCT {
          id: related.id,
          title: related.title,
          rel_type: type(r),
          rel_strength: coalesce(r.strength, 0.5)
        }) as related_memories

      ORDER BY relevance_score DESC, m.created_at DESC
      LIMIT 20

      RETURN m.id as id,
             m.title as title,
             m.content as content,
             m.type as memory_type,
             m.tags as tags,
             m.created_at as created_at,
             relevance_score,
             entity_matches,
             keyword_matches,
             related_memories
    `;

    const params: Record<string, unknown> = {
      entities: entityTexts,
      keywords,
      project,
    };

    try {
      const results = await this.backend.executeQuery(searchQuery, params, false);

      const contextParts: string[] = [];
      const sourceMemories: SourceMemory[] = [];
      let estimatedTokens = 0;

      for (const record of results) {
        const memorySummary = this.formatMemory(record);
        const memoryTokens = this.estimateTokens(memorySummary);

        if (estimatedTokens + memoryTokens > maxTokens) {
          break;
        }

        contextParts.push(memorySummary);
        sourceMemories.push({
          id: String(record["id"] ?? ""),
          title: (record["title"] as string | null | undefined) ?? null,
          relevance: Number(record["relevance_score"] ?? 0),
        });
        estimatedTokens += memoryTokens;
      }

      const context = contextParts.join("\n\n");

      return {
        context,
        source_memories: sourceMemories,
        total_memories: sourceMemories.length,
        estimated_tokens: estimatedTokens,
        query_entities: entityTexts,
        query_keywords: keywords,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error retrieving context for query '${query}': ${message}`);
      return {
        context: "",
        source_memories: [],
        error: message,
      };
    }
  }

  /**
   * Get comprehensive overview of a project.
   */
  async getProjectContext(project: string): Promise<ProjectSummary> {
    const query = `
      MATCH (m:Memory)
      WHERE $project IN m.tags

      WITH m
      ORDER BY m.created_at DESC

      WITH collect(m) as all_memories

      WITH all_memories,
        [m IN all_memories WHERE m.created_at >= datetime() - duration({days: 7})][..10] as recent,
        [m IN all_memories WHERE m.type = 'decision'][..5] as decisions,
        [m IN all_memories WHERE m.type = 'problem' AND
         NOT exists((m)<-[:SOLVES]-(:Memory))][..5] as open_problems,
        [m IN all_memories WHERE m.type = 'solution'][..5] as solutions

      RETURN {
        total_memories: size(all_memories),
        recent_activity: [m IN recent | {
          id: m.id,
          title: m.title,
          type: m.type,
          created_at: m.created_at
        }],
        decisions: [m IN decisions | {
          id: m.id,
          title: m.title,
          created_at: m.created_at
        }],
        open_problems: [m IN open_problems | {
          id: m.id,
          title: m.title,
          created_at: m.created_at
        }],
        solutions: [m IN solutions | {
          id: m.id,
          title: m.title,
          created_at: m.created_at
        }]
      } as project_summary
    `;

    const params = { project };

    try {
      const results = await this.backend.executeQuery(query, params, false);
      if (results.length > 0) {
        const summary = results[0]["project_summary"];
        if (summary && typeof summary === "object") {
          return summary as ProjectSummary;
        }
      }
      return {
        total_memories: 0,
        recent_activity: [],
        decisions: [],
        open_problems: [],
        solutions: [],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error getting project context for '${project}': ${message}`);
      return { error: message };
    }
  }

  /**
   * Get recent session context from the last N hours.
   */
  async getSessionContext(hoursBack = 24, limit = 10): Promise<SessionContext> {
    const query = `
      MATCH (m:Memory)
      WHERE m.created_at >= datetime() - duration({hours: $hours_back})

      WITH m
      ORDER BY m.created_at DESC
      LIMIT $limit

      OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
      WITH m, collect(DISTINCT e.text) as entities

      RETURN m.id as id,
             m.title as title,
             m.content as content,
             m.type as memory_type,
             m.created_at as created_at,
             entities
      ORDER BY m.created_at DESC
    `;

    const params = { hours_back: hoursBack, limit };

    try {
      const results = await this.backend.executeQuery(query, params, false);

      const memories: Record<string, unknown>[] = [];
      const allEntities = new Set<string>();

      for (const record of results) {
        const entities = (record["entities"] as string[] | undefined) ?? [];
        memories.push({
          id: record["id"],
          title: record["title"] ?? null,
          type: record["memory_type"] ?? null,
          created_at: record["created_at"] ?? null,
          entities,
        });
        for (const e of entities) allEntities.add(e);
      }

      return {
        recent_memories: memories,
        total_count: memories.length,
        time_range_hours: hoursBack,
        active_entities: Array.from(allEntities),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error getting session context: ${message}`);
      return {
        recent_memories: [],
        total_count: 0,
        time_range_hours: hoursBack,
        active_entities: [],
        error: message,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private formatMemory(record: Record<string, unknown>): string {
    const title = (record["title"] as string | null | undefined) ?? "Untitled";
    const memoryType = (record["memory_type"] as string | null | undefined) ?? "unknown";
    let content = (record["content"] as string | null | undefined) ?? "";
    const relevance = Number(record["relevance_score"] ?? 0);

    if (content.length > 500) {
      content = content.slice(0, 497) + "...";
    }

    let formatted = `## ${title} (${memoryType})\n`;
    if (relevance > 0) {
      formatted += `Relevance: ${relevance.toFixed(2)}\n`;
    }
    formatted += `${content}`;

    const related = (record["related_memories"] as Record<string, unknown>[] | undefined) ?? [];
    if (related.length > 0) {
      const relatedTitles = related
        .slice(0, 3)
        .map((r) => (r["title"] as string | null | undefined) ?? "Untitled");
      formatted += `\n\nRelated: ${relatedTitles.join(", ")}`;
    }

    return formatted;
  }

  private estimateTokens(text: string): number {
    return Math.floor(text.length / 4);
  }

  private extractKeywords(text: string): string[] {
    const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
    const keywords = words.filter((w) => !STOP_WORDS.has(w));
    return Array.from(new Set(keywords));
  }
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

export async function getContext(
  backend: GraphBackend,
  query: string,
  maxTokens = 4000,
  project: string | null = null
): Promise<QueryContext> {
  const retriever = new ContextRetriever(backend);
  return retriever.getContext(query, maxTokens, project);
}

export async function getProjectContext(
  backend: GraphBackend,
  project: string
): Promise<ProjectSummary> {
  const retriever = new ContextRetriever(backend);
  return retriever.getProjectContext(project);
}

export async function getSessionContext(
  backend: GraphBackend,
  hoursBack = 24,
  limit = 10
): Promise<SessionContext> {
  const retriever = new ContextRetriever(backend);
  return retriever.getSessionContext(hoursBack, limit);
}
