/**
 * Predictive Suggestions for MemoryGraph.
 *
 * Port of the Python `memorygraph.proactive.predictive` module.
 * Provides proactive suggestions based on current context:
 * - Predict relevant memories and patterns
 * - Warn about potential issues
 * - Suggest related context
 */

import type { GraphBackend } from "../backends/index.ts";
import { extractEntities, type Entity } from "../intelligence/entity-extraction.ts";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Proactive suggestion for relevant memory or pattern. */
export interface Suggestion {
  suggestion_id: string;
  suggestion_type: string;
  title: string;
  description: string;
  relevance_score: number;
  reason: string;
  memory_id: string;
  tags: string[];
  effectiveness?: number | null;
}

/** Warning about potential issues. */
export interface Warning {
  warning_id: string;
  severity: string;
  title: string;
  description: string;
  evidence: string[];
  mitigation?: string | null;
  related_problem_id?: string | null;
}

// ---------------------------------------------------------------------------
// Predict needs
// ---------------------------------------------------------------------------

/**
 * Predict relevant memories and patterns based on current context.
 *
 * Uses entity extraction and relationship matching to find relevant information.
 *
 * @param backend - Database backend
 * @param currentContext - Current work context (e.g., file content, task description)
 * @param maxSuggestions - Maximum number of suggestions to return
 * @param minRelevance - Minimum relevance score threshold
 * @returns List of suggestions ranked by relevance
 */
export async function predictNeeds(
  backend: GraphBackend,
  currentContext: string,
  maxSuggestions = 5,
  minRelevance = 0.3
): Promise<Suggestion[]> {
  console.info("Predicting needs from current context");

  const entities = extractEntities(currentContext);
  console.debug(`Extracted ${entities.length} entities from context`);

  if (entities.length === 0) {
    console.warn("No entities extracted from context");
    return [];
  }

  const suggestions: Suggestion[] = [];

  // Find memories that mention the same entities
  for (const entity of entities.slice(0, 10)) {
    const entityQuery = `
      MATCH (m:Memory)-[:MENTIONS]->(e:Entity {text: $entity_text})
      WHERE m.type IN ['solution', 'code_pattern', 'fix']
      OPTIONAL MATCH (m)-[r:EFFECTIVE_FOR|SOLVES|ADDRESSES]->()
      RETURN m.id as id, m.type as type, m.title as title,
             m.content as content, m.tags as tags,
             m.effectiveness as effectiveness,
             m.usage_count as usage_count,
             count(r) as effectiveness_links
      ORDER BY m.effectiveness DESC, m.usage_count DESC
      LIMIT 3
    `;

    try {
      const results = await backend.executeQuery(entityQuery, { entity_text: entity.text });

      for (const record of results ?? []) {
        const baseScore = entity.confidence;
        const effectivenessBonus = ((record["effectiveness"] as number) ?? 0.5) * 0.3;
        const usageBonus = Math.min(((record["usage_count"] as number) ?? 0) / 10.0, 0.2);
        const linksBonus = Math.min(((record["effectiveness_links"] as number) ?? 0) / 5.0, 0.2);

        let relevance = baseScore + effectivenessBonus + usageBonus + linksBonus;
        relevance = Math.min(relevance, 1.0);

        if (relevance >= minRelevance) {
          const content = (record["content"] as string) ?? "";
          suggestions.push({
            suggestion_id: record["id"] as string,
            suggestion_type: (record["type"] as string) ?? "",
            title: (record["title"] as string) ?? "",
            description: content.slice(0, 200),
            relevance_score: relevance,
            reason: `Related to ${entity.entity_type}: ${entity.text}`,
            memory_id: record["id"] as string,
            tags: (record["tags"] as string[]) ?? [],
            effectiveness: (record["effectiveness"] as number | undefined) ?? null,
          });
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error querying memories for entity ${entity.text}: ${message}`);
    }
  }

  // Find patterns that match the context
  const patternKeywords: Array<[string, number]> = entities
    .filter((e) => e.entity_type === "technology" || e.entity_type === "concept")
    .map((e) => [e.text.toLowerCase(), e.confidence]);

  if (patternKeywords.length > 0) {
    const patternQuery = `
      MATCH (p:Memory {type: 'code_pattern'})
      WHERE any(keyword IN $keywords WHERE p.content CONTAINS keyword)
      RETURN p.id as id, p.title as title, p.content as content,
             p.tags as tags, p.effectiveness as effectiveness,
             p.usage_count as usage_count
      ORDER BY p.effectiveness DESC
      LIMIT 3
    `;

    try {
      const avgConfidence =
        patternKeywords.reduce((sum, [, conf]) => sum + conf, 0) / patternKeywords.length;
      const keywordsOnly = patternKeywords.map(([kw]) => kw);

      const results = await backend.executeQuery(patternQuery, { keywords: keywordsOnly });

      for (const record of results ?? []) {
        const effectiveness = (record["effectiveness"] as number) ?? 0.5;
        const usageCount = (record["usage_count"] as number) ?? 0;

        let relevance = avgConfidence + effectiveness * 0.3 + Math.min(usageCount / 10.0, 0.1);
        relevance = Math.min(relevance, 1.0);

        if (relevance >= minRelevance) {
          const content = (record["content"] as string) ?? "";
          suggestions.push({
            suggestion_id: record["id"] as string,
            suggestion_type: "pattern",
            title: (record["title"] as string) ?? "",
            description: content.slice(0, 200),
            relevance_score: relevance,
            reason: "Matching pattern for current context",
            memory_id: record["id"] as string,
            tags: (record["tags"] as string[]) ?? [],
            effectiveness: (record["effectiveness"] as number | undefined) ?? null,
          });
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error querying patterns: ${message}`);
    }
  }

  // Deduplicate and sort by relevance
  const seenIds = new Set<string>();
  const uniqueSuggestions: Suggestion[] = [];
  const sorted = [...suggestions].sort((a, b) => b.relevance_score - a.relevance_score);
  for (const suggestion of sorted) {
    if (!seenIds.has(suggestion.memory_id)) {
      uniqueSuggestions.push(suggestion);
      seenIds.add(suggestion.memory_id);
    }
  }

  console.info(`Generated ${uniqueSuggestions.length} suggestions`);
  return uniqueSuggestions.slice(0, maxSuggestions);
}

// ---------------------------------------------------------------------------
// Warn potential issues
// ---------------------------------------------------------------------------

/**
 * Warn about potential issues based on current context.
 *
 * @param backend - Database backend
 * @param currentContext - Current work context
 * @param severityThreshold - Minimum severity to report ("low", "medium", "high")
 * @returns List of warnings with evidence
 */
export async function warnPotentialIssues(
  backend: GraphBackend,
  currentContext: string,
  severityThreshold = "medium"
): Promise<Warning[]> {
  console.info("Checking for potential issues in current context");

  const entities = extractEntities(currentContext);
  const warnings: Warning[] = [];

  const entityTexts = entities.map((e) => e.text);

  // Check for deprecated approaches
  if (entityTexts.length > 0) {
    const deprecatedQuery = `
      MATCH (old:Memory)-[r:DEPRECATED_BY]->(new:Memory)
      MATCH (old)-[:MENTIONS]->(e:Entity)
      WHERE e.text IN $entity_texts
      RETURN old.id as old_id, old.title as old_title,
             old.content as old_content,
             new.id as new_id, new.title as new_title,
             r.context as reason,
             collect(e.text) as entities
    `;

    try {
      const results = await backend.executeQuery(deprecatedQuery, { entity_texts: entityTexts });

      for (const record of results ?? []) {
        warnings.push({
          warning_id: record["old_id"] as string,
          severity: "high",
          title: `Deprecated: ${record["old_title"] as string}`,
          description: ((record["reason"] as string) ?? "This approach is deprecated"),
          evidence: [record["old_id"] as string],
          mitigation: `Consider using: ${record["new_title"] as string}`,
          related_problem_id: record["old_id"] as string,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error checking for deprecated approaches: ${message}`);
    }
  }

  // Check for known problem patterns
  const problemKeywords = entities.map((e) => e.text.toLowerCase());

  if (problemKeywords.length > 0) {
    const problemQuery = `
      MATCH (p:Memory {type: 'problem'})
      WHERE any(keyword IN $keywords WHERE p.content CONTAINS keyword)
      OPTIONAL MATCH (p)-[:SOLVES|ADDRESSES]-(s:Memory {type: 'solution'})
      RETURN p.id as problem_id, p.title as problem_title,
             p.content as problem_content, p.tags as tags,
             collect(s.id) as solution_ids,
             collect(s.title) as solution_titles
      LIMIT 5
    `;

    try {
      const results = await backend.executeQuery(problemQuery, { keywords: problemKeywords });

      for (const record of results ?? []) {
        const solutionIds = (record["solution_ids"] as string[]) ?? [];
        const solutionTitles = (record["solution_titles"] as string[]) ?? [];
        const hasSolutions = solutionIds.length > 0 && solutionIds.some((id) => id !== null);

        let mitigation: string;
        let severity: string;
        if (hasSolutions) {
          mitigation = `Known solutions: ${solutionTitles.slice(0, 2).join(", ")}`;
          severity = "medium";
        } else {
          mitigation = "No known solution yet - proceed with caution";
          severity = "high";
        }

        const problemContent = (record["problem_content"] as string) ?? "";
        warnings.push({
          warning_id: record["problem_id"] as string,
          severity,
          title: `Known issue: ${record["problem_title"] as string}`,
          description: problemContent.slice(0, 200),
          evidence: [record["problem_id"] as string],
          mitigation,
          related_problem_id: record["problem_id"] as string,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error checking for known problems: ${message}`);
    }
  }

  // Filter by severity threshold
  const severityLevels: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const thresholdLevel = severityLevels[severityThreshold] ?? 1;

  const filteredWarnings = warnings.filter(
    (w) => (severityLevels[w.severity] ?? 0) >= thresholdLevel
  );

  console.info(`Generated ${filteredWarnings.length} warnings`);
  return filteredWarnings;
}

// ---------------------------------------------------------------------------
// Suggest related context
// ---------------------------------------------------------------------------

/**
 * Suggest related context that the user might want to know about.
 *
 * @param backend - Database backend
 * @param memoryId - Current memory being viewed
 * @param maxSuggestions - Maximum number of suggestions
 * @returns List of related suggestions
 */
export async function suggestRelatedContext(
  backend: GraphBackend,
  memoryId: string,
  maxSuggestions = 5
): Promise<Suggestion[]> {
  console.info(`Suggesting related context for memory ${memoryId}`);

  const relatedQuery = `
    MATCH (m:Memory {id: $memory_id})-[r]->(related:Memory)
    WHERE r.strength >= 0.5
      AND type(r) IN ['BUILDS_ON', 'CONFIRMS', 'SIMILAR_TO', 'RELATED_TO',
                      'ALTERNATIVE_TO', 'IMPROVES']
    RETURN related.id as id, related.type as type, related.title as title,
           related.content as content, related.tags as tags,
           related.effectiveness as effectiveness,
           type(r) as rel_type, r.strength as strength
    ORDER BY r.strength DESC
    LIMIT $limit
  `;

  const suggestions: Suggestion[] = [];

  try {
    const results = await backend.executeQuery(relatedQuery, {
      memory_id: memoryId,
      limit: maxSuggestions,
    });

    const reasons: Record<string, string> = {
      BUILDS_ON: "Builds on this concept",
      CONFIRMS: "Confirms this approach",
      SIMILAR_TO: "Similar approach",
      RELATED_TO: "Related information",
      ALTERNATIVE_TO: "Alternative approach",
      IMPROVES: "Improved version",
    };

    for (const record of results ?? []) {
      const relType = record["rel_type"] as string;
      const strength = (record["strength"] as number) ?? 0.5;
      const content = (record["content"] as string) ?? "";

      suggestions.push({
        suggestion_id: record["id"] as string,
        suggestion_type: (record["type"] as string) ?? "",
        title: (record["title"] as string) ?? "",
        description: content.slice(0, 200),
        relevance_score: strength,
        reason: reasons[relType] ?? "Related",
        memory_id: record["id"] as string,
        tags: (record["tags"] as string[]) ?? [],
        effectiveness: (record["effectiveness"] as number | undefined) ?? null,
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error finding related context: ${message}`);
  }

  console.info(`Found ${suggestions.length} related suggestions`);
  return suggestions.slice(0, maxSuggestions);
}
