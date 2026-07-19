/**
 * Pattern Recognition - Identify reusable patterns from accumulated memories.
 *
 * Port of the Python `memorygraph.intelligence.pattern_recognition` module.
 * Recognizes patterns in memories using keyword and entity matching.
 */

import type { GraphBackend } from "../backends/index.ts";
import { extractEntities } from "./entity-extraction.ts";

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

export interface Pattern {
  id: string;
  name: string;
  description: string;
  pattern_type: string;
  confidence: number;
  occurrences: number;
  source_memory_ids: string[];
  entities: string[];
  created_at: string;
  effectiveness?: number | null;
  context?: Record<string, unknown> | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Pattern recognizer
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at",
  "to", "for", "of", "with", "by", "from", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "should", "could", "may",
  "might", "can", "this", "that", "these", "those",
]);

export class PatternRecognizer {
  backend: GraphBackend;

  constructor(backend: GraphBackend) {
    this.backend = backend;
  }

  /**
   * Find similar problems and their solutions using keyword matching.
   */
  async findSimilarProblems(
    problem: string,
    threshold = 0.7,
    limit = 10
  ): Promise<Record<string, unknown>[]> {
    const keywords = this.extractKeywords(problem);
    if (keywords.length === 0) return [];

    const query = `
      MATCH (m:Memory {type: 'problem'})
      WHERE any(keyword IN $keywords WHERE toLower(m.content) CONTAINS keyword)
      OPTIONAL MATCH (m)-[r:SOLVES|SOLVED_BY]-(solution:Memory)
      WITH m, solution, r,
           size([keyword IN $keywords WHERE toLower(m.content) CONTAINS keyword]) as match_count
      WITH m, solution, r,
           toFloat(match_count) / toFloat(size($keywords)) as similarity
      WHERE similarity >= $threshold
      ORDER BY similarity DESC, m.created_at DESC
      LIMIT $limit
      RETURN m.id as problem_id,
             m.title as problem_title,
             m.content as problem_content,
             m.created_at as created_at,
             similarity,
             collect({
               id: solution.id,
               title: solution.title,
               content: solution.content,
               effectiveness: r.effectiveness
             }) as solutions
    `;

    const params = { keywords, threshold, limit };

    try {
      const results = await this.backend.executeQuery(query, params, false);
      return results.map((r) => ({ ...r }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error finding similar problems: ${message}`);
      return [];
    }
  }

  /**
   * Extract common patterns from memories of a given type.
   */
  async extractPatterns(
    memoryType = "solution",
    minOccurrences = 3
  ): Promise<Pattern[]> {
    const query = `
      MATCH (m:Memory {type: $memory_type})-[:MENTIONS]->(e:Entity)
      WITH e.text as entity, e.type as entity_type,
           collect(m.id) as memory_ids,
           count(m) as occurrence_count
      WHERE occurrence_count >= $min_occurrences
      RETURN entity, entity_type, memory_ids, occurrence_count
      ORDER BY occurrence_count DESC
      LIMIT 50
    `;

    const params = {
      memory_type: memoryType,
      min_occurrences: minOccurrences,
    };

    try {
      const entityResults = await this.backend.executeQuery(query, params, false);
      const patterns: Pattern[] = [];

      for (const result of entityResults) {
        const entity = String(result["entity"] ?? "");
        const entityType = String(result["entity_type"] ?? "");
        const occurrenceCount = Number(result["occurrence_count"] ?? 0);
        const memoryIds = (result["memory_ids"] as string[] | undefined) ?? [];

        patterns.push({
          id: `pattern-${entity}-${Date.now()}`,
          name: `${entityType} Pattern: ${entity}`,
          description: `Common ${memoryType} pattern involving ${entity}`,
          pattern_type: memoryType,
          confidence: Math.min(occurrenceCount / 10.0, 1.0),
          occurrences: occurrenceCount,
          source_memory_ids: memoryIds,
          entities: [entity],
          created_at: nowIso(),
          effectiveness: null,
          context: null,
        });
      }

      if (entityResults.length > 1) {
        const coOccurrences = await this.findEntityCoOccurrences(memoryType, minOccurrences);
        patterns.push(...coOccurrences);
      }

      return patterns;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error extracting patterns: ${message}`);
      return [];
    }
  }

  private async findEntityCoOccurrences(
    memoryType: string,
    minOccurrences: number
  ): Promise<Pattern[]> {
    const query = `
      MATCH (m:Memory {type: $memory_type})-[:MENTIONS]->(e1:Entity)
      MATCH (m)-[:MENTIONS]->(e2:Entity)
      WHERE id(e1) < id(e2)
      WITH e1.text as entity1, e2.text as entity2,
           collect(m.id) as memory_ids,
           count(m) as occurrence_count
      WHERE occurrence_count >= $min_occurrences
      RETURN entity1, entity2, memory_ids, occurrence_count
      ORDER BY occurrence_count DESC
      LIMIT 20
    `;

    const params = {
      memory_type: memoryType,
      min_occurrences: minOccurrences,
    };

    try {
      const results = await this.backend.executeQuery(query, params, false);
      const patterns: Pattern[] = [];

      for (const result of results) {
        const entity1 = String(result["entity1"] ?? "");
        const entity2 = String(result["entity2"] ?? "");
        const occurrenceCount = Number(result["occurrence_count"] ?? 0);
        const memoryIds = (result["memory_ids"] as string[] | undefined) ?? [];

        patterns.push({
          id: `pattern-pair-${entity1}-${entity2}-${Date.now()}`,
          name: `Co-occurrence: ${entity1} + ${entity2}`,
          description: `Frequent ${memoryType} pattern combining ${entity1} and ${entity2}`,
          pattern_type: `${memoryType}_combination`,
          confidence: Math.min(occurrenceCount / 5.0, 1.0),
          occurrences: occurrenceCount,
          source_memory_ids: memoryIds,
          entities: [entity1, entity2],
          created_at: nowIso(),
          effectiveness: null,
          context: null,
        });
      }

      return patterns;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error finding co-occurrences: ${message}`);
      return [];
    }
  }

  /**
   * Suggest relevant patterns for given context.
   */
  async suggestPatterns(context: string, limit = 5): Promise<Pattern[]> {
    const entities = extractEntities(context);
    if (entities.length === 0) return [];

    const entityTexts = entities.map((e) => e.text);

    const query = `
      UNWIND $entities as entity_text
      MATCH (m:Memory)-[:MENTIONS]->(e:Entity {text: entity_text})
      WITH m, collect(DISTINCT e.text) as matched_entities
      WHERE size(matched_entities) >= 1
      OPTIONAL MATCH (m)-[:MENTIONS]->(all_entities:Entity)
      WITH m, matched_entities,
           collect(DISTINCT all_entities.text) as all_entity_texts,
           size(matched_entities) as match_count
      RETURN m.id as memory_id,
             m.type as memory_type,
             m.title as title,
             m.content as content,
             matched_entities,
             all_entity_texts,
             match_count
      ORDER BY match_count DESC, m.created_at DESC
      LIMIT $limit
    `;

    const params = { entities: entityTexts, limit: limit * 2 };

    try {
      const results = await this.backend.executeQuery(query, params, false);
      const patterns: Pattern[] = [];
      const entityTextSet = new Set(entityTexts);

      for (const result of results.slice(0, limit)) {
        const matchedEntities = (result["matched_entities"] as string[] | undefined) ?? [];
        const allEntityTexts = (result["all_entity_texts"] as string[] | undefined) ?? [];

        const overlap = matchedEntities.filter((e) => entityTextSet.has(e)).length;
        const totalEntities = new Set(allEntityTexts).size;
        const relevance = totalEntities > 0 ? overlap / totalEntities : 0;

        patterns.push({
          id: String(result["memory_id"] ?? ""),
          name: String(result["title"] ?? "Untitled Pattern"),
          description: String(result["content"] ?? "").slice(0, 200),
          pattern_type: String(result["memory_type"] ?? "unknown"),
          confidence: Math.min(relevance, 1.0),
          occurrences: Number(result["match_count"] ?? 0),
          source_memory_ids: [String(result["memory_id"] ?? "")],
          entities: matchedEntities,
          created_at: nowIso(),
          effectiveness: null,
          context: null,
        });
      }

      return patterns;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error suggesting patterns: ${message}`);
      return [];
    }
  }

  /**
   * Extract keywords from text for matching.
   */
  extractKeywords(text: string): string[] {
    const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
    const keywords = words.filter((w) => !STOP_WORDS.has(w));
    return Array.from(new Set(keywords));
  }
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

export async function findSimilarProblems(
  backend: GraphBackend,
  problem: string,
  threshold = 0.7,
  limit = 10
): Promise<Record<string, unknown>[]> {
  const recognizer = new PatternRecognizer(backend);
  return recognizer.findSimilarProblems(problem, threshold, limit);
}

export async function extractPatterns(
  backend: GraphBackend,
  memoryType = "solution",
  minOccurrences = 3
): Promise<Pattern[]> {
  const recognizer = new PatternRecognizer(backend);
  return recognizer.extractPatterns(memoryType, minOccurrences);
}

export async function suggestPatterns(
  backend: GraphBackend,
  context: string,
  limit = 5
): Promise<Pattern[]> {
  const recognizer = new PatternRecognizer(backend);
  return recognizer.suggestPatterns(context, limit);
}
