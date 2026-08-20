/**
 * Context-Aware Retrieval - Intelligent context retrieval beyond keyword search.
 *
 * Port of the Python `memorygraph.intelligence.context_retrieval` module.
 * Provides smart context assembly, relevance ranking, and token-limited
 * context formatting.
 */

import type { GraphBackend } from "../backends/index.js";
import { extractEntities } from "./entity-extraction.js";
import { parseDatetime } from "../utils/datetime.js";

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

/**
 * Parse a stored creation timestamp into a valid Date, or `null` if it is
 * missing/invalid. Falls back to sharing the project-wide `parseDatetime`.
 */
function parseCreationDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const dt = parseDatetime(value as string | Date);
  return isNaN(dt.getTime()) ? null : dt;
}

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
      OPTIONAL MATCH (m)-[:MENTIONS]->(me:Entity)
      WITH m,
        [x IN collect(DISTINCT me.text) WHERE x IS NOT NULL] as mentioned_entities
      WHERE (
        any(e IN mentioned_entities WHERE toLower(e) IN $lower_entities)
        OR
        any(keyword IN $keywords WHERE
          toLower(m.content) CONTAINS keyword OR
          toLower(m.title) CONTAINS keyword
        )
      )
      AND ($project IS NULL OR $project IN m.tags)

      OPTIONAL MATCH (m)-[r]->(related:Memory)
      WHERE type(r) IN ['SOLVES', 'BUILDS_ON', 'REQUIRES', 'RELATED_TO']
      // Filter null-id entries *inside* the collected list. When OPTIONAL
      // MATCH finds no related memory it still emits one row with a null
      // related/r; without the in-list filter an empty list id would be kept
      // only by dropping the whole Memory row, which would remove standalone
      // memories from ranking.
      WITH m, mentioned_entities,
        [x IN collect(DISTINCT {
          id: related.id,
          title: related.title,
          rel_type: type(r),
          rel_strength: coalesce(r.strength, 0.5)
        }) WHERE x.id IS NOT NULL] as related_memories

      RETURN m.id as id,
             m.title as title,
             m.content as content,
             m.type as memory_type,
             m.tags as tags,
             m.created_at as created_at,
             related_memories,
             mentioned_entities
      // Rank deterministically before capping so the LIMIT never drops an
      // arbitrary slice of the matching set before the TS ranking runs.
      ORDER BY m.created_at DESC
      LIMIT 100
    `;

    const params: Record<string, unknown> = {
      lower_entities: entityTexts.map((e) => e.toLowerCase()),
      keywords,
      project,
    };

    try {
      const results = await this.backend.executeQuery(searchQuery, params, false);

      const now = Date.now();
      const ranked = results
        .map((record) => {
          const content = ((record["content"] as string) ?? "").toLowerCase();
          const title = ((record["title"] as string) ?? "").toLowerCase();
          const mentioned = (record["mentioned_entities"] as string[] | undefined) ?? [];
          const mentionedLow = mentioned.map((t) => t.toLowerCase());
          const lowerEntities = entityTexts.map((e) => e.toLowerCase());
          let entityMatches = 0;
          for (const e of lowerEntities) {
            if (mentionedLow.includes(e)) entityMatches++;
          }
          let keywordMatches = 0;
          for (const k of keywords) {
            if (content.includes(k) || title.includes(k)) {
              keywordMatches++;
            }
          }
          const created = parseCreationDate(record["created_at"]);
          const ageDays = created ? (now - created.getTime()) / (1000 * 60 * 60 * 24) : 30;
          const relevanceScore =
            (entityMatches * 3 + keywordMatches * 2) / (1.0 + ageDays / 30.0);
          return { record, relevanceScore };
        })
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

      const contextParts: string[] = [];
      const sourceMemories: SourceMemory[] = [];
      let estimatedTokens = 0;

      for (const { record, relevanceScore } of ranked) {
        const memorySummary = this.formatMemory(record, relevanceScore ?? 0);
        const memoryTokens = this.estimateTokens(memorySummary);

        if (estimatedTokens + memoryTokens > maxTokens) {
          break;
        }

        contextParts.push(memorySummary);
        sourceMemories.push({
          id: String(record["id"] ?? ""),
          title: (record["title"] as string | null | undefined) ?? null,
          relevance: Number(relevanceScore ?? 0),
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
    const params = { project };

    // Each query pushes its cap into the database (ORDER BY + LIMIT) instead
    // of dragging every project memory back into one unbounded collect() row.
    // total_memories comes from a dedicated count(m) query.
    const countQuery = `
      MATCH (m:Memory)
      WHERE $project IN m.tags
      RETURN count(m) as total
    `;
    const openQuery = `
      MATCH (m:Memory)
      WHERE $project IN m.tags
        AND m.type = 'problem'
        AND NOT (m)<-[:SOLVES|ADDRESSES]-(:Memory)
      RETURN m.id as id, m.title as title, m.type as type, m.created_at as created_at
      ORDER BY m.created_at DESC
      LIMIT 5
    `;
    const recentQuery = `
      MATCH (m:Memory)
      WHERE $project IN m.tags
      RETURN m.id as id, m.title as title, m.type as type, m.created_at as created_at
      ORDER BY m.created_at DESC
      LIMIT 10
    `;
    const decisionsQuery = `
      MATCH (m:Memory)
      WHERE $project IN m.tags AND m.type = 'decision'
      RETURN m.id as id, m.title as title, m.type as type, m.created_at as created_at
      ORDER BY m.created_at DESC
      LIMIT 5
    `;
    const solutionsQuery = `
      MATCH (m:Memory)
      WHERE $project IN m.tags AND m.type = 'solution'
      RETURN m.id as id, m.title as title, m.type as type, m.created_at as created_at
      ORDER BY m.created_at DESC
      LIMIT 5
    `;

    try {
      const [countRes, openRes, recentRes, decisionsRes, solutionsRes] =
        await Promise.all([
          this.backend.executeQuery(countQuery, params, false),
          this.backend.executeQuery(openQuery, params, false),
          this.backend.executeQuery(recentQuery, params, false),
          this.backend.executeQuery(decisionsQuery, params, false),
          this.backend.executeQuery(solutionsQuery, params, false),
        ]);

      const totalMemories =
        countRes.length > 0 ? Number(countRes[0]["total"] ?? 0) : 0;

      // Cap to the recent window (7 days) in JS, matching the prior behaviour
      // while remaining length-bounded by the query LIMIT above.
      const now = Date.now();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const recent = (recentRes ?? []).filter((m) => {
        const created = parseCreationDate(m["created_at"]);
        return created !== null && now - created.getTime() <= weekMs;
      });

      const sortByCreatedDesc = (a: Record<string, unknown>, b: Record<string, unknown>) => {
        const ta = parseCreationDate(a["created_at"]);
        const tb = parseCreationDate(b["created_at"]);
        const va = ta ? ta.getTime() : 0;
        const vb = tb ? tb.getTime() : 0;
        return vb - va;
      };

      const openProblems = (openRes ?? [])
        .slice()
        .sort(sortByCreatedDesc)
        .slice(0, 5);
      const decisions = (decisionsRes ?? []).slice().sort(sortByCreatedDesc).slice(0, 5);
      const solutions = (solutionsRes ?? []).slice().sort(sortByCreatedDesc).slice(0, 5);

      const toSummary = (m: Record<string, unknown>) => ({
        id: m["id"],
        title: m["title"],
        type: m["type"],
        created_at: m["created_at"],
      });

      return {
        total_memories: totalMemories,
        recent_activity: recent.map(toSummary),
        decisions: decisions.map((d) => ({
          id: d["id"],
          title: d["title"],
          created_at: d["created_at"],
        })),
        open_problems: openProblems.map((d) => ({
          id: d["id"],
          title: d["title"],
          created_at: d["created_at"],
        })),
        solutions: solutions.map((d) => ({
          id: d["id"],
          title: d["title"],
          created_at: d["created_at"],
        })),
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
      WHERE m.created_at >= $cutoff

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

    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const params = { cutoff, limit };

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

  private formatMemory(record: Record<string, unknown>, relevanceScore = 0): string {
    const title = (record["title"] as string | null | undefined) ?? "Untitled";
    const memoryType = (record["memory_type"] as string | null | undefined) ?? "unknown";
    let content = (record["content"] as string | null | undefined) ?? "";
    const relevance = Number(relevanceScore ?? 0);

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
