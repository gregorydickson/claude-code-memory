/**
 * Advanced Analytics Queries for MemoryGraph.
 *
 * Port of the Python `memorygraph.analytics.advanced_queries` module.
 * Provides sophisticated graph analytics:
 * - Graph visualization data (D3/vis.js compatible)
 * - Solution similarity matching
 * - Solution effectiveness prediction
 * - Learning path recommendations
 * - Knowledge gap identification
 * - Memory ROI tracking
 */

import type { GraphBackend } from "../backends/index.js";
import { parseDatetime } from "../utils/datetime.js";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Node in visualization graph. */
export interface GraphNode {
  id: string;
  label: string;
  type: string;
  group: number;
  value: number;
  title?: string | null;
}

/** Edge in visualization graph. */
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  value: number;
  title?: string | null;
}

/** Graph visualization data compatible with D3.js and vis.js. */
export interface GraphVisualizationData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: Record<string, unknown>;
}

/** Similar solution to a given solution. */
export interface SimilarSolution {
  solution_id: string;
  title: string;
  description: string;
  similarity_score: number;
  shared_entities: string[];
  shared_tags: string[];
  effectiveness?: number | null;
}

/** Recommended learning path for a topic. */
export interface LearningPath {
  path_id: string;
  topic: string;
  steps: Array<Record<string, string | number>>;
  total_memories: number;
  estimated_value: number;
}

/** Identified knowledge gap. */
export interface KnowledgeGap {
  gap_id: string;
  topic: string;
  description: string;
  severity: string;
  related_memories: number;
  suggestions: string[];
}

/** Memory return on investment tracking. */
export interface MemoryROI {
  memory_id: string;
  title: string;
  creation_date: Date;
  times_accessed: number;
  times_helpful: number;
  success_rate: number;
  value_score: number;
  last_used?: Date | null;
}

// ---------------------------------------------------------------------------
// Graph visualization
// ---------------------------------------------------------------------------

/**
 * Get graph visualization data centered on a memory or full graph.
 *
 * @param backend - Database backend
 * @param centerMemoryId - Optional center memory (null = full graph)
 * @param depth - Depth to traverse from center
 * @param maxNodes - Maximum nodes to return
 * @param includeTypes - Filter to specific memory types
 * @returns GraphVisualizationData for D3/vis.js
 */
export async function getMemoryGraphVisualization(
  backend: GraphBackend,
  centerMemoryId?: string | null,
  depth = 2,
  maxNodes = 100,
  includeTypes?: string[] | null
): Promise<GraphVisualizationData> {
  console.info(
    `Generating graph visualization: center=${centerMemoryId ?? "full"}, depth=${depth}`
  );

  const visualization: GraphVisualizationData = {
    nodes: [],
    edges: [],
    metadata: {
      node_count: 0,
      edge_count: 0,
      center_id: centerMemoryId ?? null,
      depth,
      generated_at: new Date().toISOString(),
    },
  };

  let query: string;
  let params: Record<string, unknown>;

  if (centerMemoryId) {
    query = `
      MATCH path = (center:Memory {id: $center_id})-[*1..${depth}]-(m:Memory)
      WITH center, m, relationships(path) as rels
      UNWIND rels as rel
      WITH center, m, collect(DISTINCT rel) as allRels
      WITH collect(DISTINCT center) + collect(DISTINCT m) as memories,
           collect(DISTINCT { id: id(rel), from_id: startNode(rel).id, to_id: endNode(rel).id, type: type(rel), strength: rel.strength }) as relationships
      RETURN memories, relationships
      LIMIT 1
    `;
    params = { center_id: centerMemoryId, depth };
  } else {
    const typeFilter = includeTypes ? "WHERE m.type IN $types" : "";
    query = `
      MATCH (m:Memory)
      ${typeFilter}
      WITH m
      LIMIT $max_nodes
      OPTIONAL MATCH (m)-[r]-(other:Memory)
      WHERE other.id IN [m2 IN collect(m) | m2.id]
      WITH collect(DISTINCT m) as memories,
           collect(DISTINCT { id: id(r), from_id: startNode(r).id, to_id: endNode(r).id, type: type(r), strength: r.strength }) as relationships
      RETURN memories, relationships
    `;
    params = { max_nodes: maxNodes };
    if (includeTypes) {
      params.types = includeTypes;
    }
  }

  try {
    const results = await backend.executeQuery(query, params);
    if (!results || results.length === 0) {
      return visualization;
    }

    const memories = (results[0]["memories"] as Record<string, unknown>[]) ?? [];
    const relationships = (results[0]["relationships"] as Record<string, unknown>[]) ?? [];

    const typeGroups: Record<string, number> = {
      problem: 0,
      solution: 1,
      code_pattern: 2,
      task: 3,
      project: 4,
    };

    for (const mem of memories.slice(0, maxNodes)) {
      const memType = (mem["type"] as string) ?? "general";
      const title = (mem["title"] as string) ?? "Untitled";
      visualization.nodes.push({
        id: mem["id"] as string,
        label: title.slice(0, 50),
        type: memType,
        group: typeGroups[memType] ?? 5,
        value: ((mem["importance"] as number) ?? 0.5) * 10,
        title: `${memType}: ${title}`,
      });
    }

    for (const rel of relationships) {
      const relType = (rel["type"] as string) ?? "RELATED_TO";
      const strength = (rel["strength"] as number) ?? 0.5;
      visualization.edges.push({
        from: rel["from_id"] as string,
        to: rel["to_id"] as string,
        type: relType,
        value: strength * 5,
        title: `${relType} (strength: ${strength.toFixed(2)})`,
      });
    }

    visualization.metadata["node_count"] = visualization.nodes.length;
    visualization.metadata["edge_count"] = visualization.edges.length;

    console.info(
      `Generated visualization: ${visualization.nodes.length} nodes, ${visualization.edges.length} edges`
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error generating visualization: ${message}`);
  }

  return visualization;
}

// ---------------------------------------------------------------------------
// Solution similarity
// ---------------------------------------------------------------------------

/**
 * Find solutions similar to a given solution.
 *
 * Uses shared entities, tags, and problem types to calculate similarity.
 *
 * @param backend - Database backend
 * @param solutionId - Solution to find similar solutions for
 * @param topK - Number of similar solutions to return
 * @param minSimilarity - Minimum similarity threshold
 * @returns List of similar solutions ranked by similarity
 */
export async function analyzeSolutionSimilarity(
  backend: GraphBackend,
  solutionId: string,
  topK = 5,
  minSimilarity = 0.3
): Promise<SimilarSolution[]> {
  console.info(`Analyzing similarity for solution ${solutionId}`);

  const targetQuery = `
    MATCH (s:Memory {id: $solution_id})
    OPTIONAL MATCH (s)-[:MENTIONS]->(e:Entity)
    RETURN s.tags as tags, collect(e.text) as entities
  `;

  try {
    const result = await backend.executeQuery(targetQuery, { solution_id: solutionId });
    if (!result || result.length === 0) {
      return [];
    }

    const targetTags = new Set((result[0]["tags"] as string[]) ?? []);
    const targetEntities = new Set((result[0]["entities"] as string[]) ?? []);

    const similarityQuery = `
      MATCH (other:Memory)
      WHERE other.id <> $solution_id
        AND other.type IN ['solution', 'fix']
      OPTIONAL MATCH (other)-[:MENTIONS]->(e:Entity)
      WITH other,
           other.tags as tags,
           collect(e.text) as entities
      RETURN other.id as id, other.title as title,
             other.content as content, tags, entities,
             other.effectiveness as effectiveness
      LIMIT 50
    `;

    const results = await backend.executeQuery(similarityQuery, { solution_id: solutionId });

    const similarSolutions: SimilarSolution[] = [];

    for (const record of results ?? []) {
      const otherTags = new Set((record["tags"] as string[]) ?? []);
      const otherEntities = new Set((record["entities"] as string[]) ?? []);

      const sharedEntities = new Set([...targetEntities].filter((e) => otherEntities.has(e)));
      const sharedTags = new Set([...targetTags].filter((t) => otherTags.has(t)));

      const entityUnion = new Set([...targetEntities, ...otherEntities]);
      const tagUnion = new Set([...targetTags, ...otherTags]);

      const entitySimilarity =
        entityUnion.size > 0 ? sharedEntities.size / entityUnion.size : 0.0;
      const tagSimilarity = tagUnion.size > 0 ? sharedTags.size / tagUnion.size : 0.0;

      const similarity = entitySimilarity * 0.6 + tagSimilarity * 0.4;

      if (similarity >= minSimilarity) {
        const content = (record["content"] as string) ?? "";
        similarSolutions.push({
          solution_id: record["id"] as string,
          title: (record["title"] as string) ?? "",
          description: content.slice(0, 200),
          similarity_score: similarity,
          shared_entities: Array.from(sharedEntities),
          shared_tags: Array.from(sharedTags),
          effectiveness: (record["effectiveness"] as number | undefined) ?? null,
        });
      }
    }

    similarSolutions.sort((a, b) => b.similarity_score - a.similarity_score);

    console.info(`Found ${similarSolutions.length} similar solutions`);
    return similarSolutions.slice(0, topK);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error analyzing similarity: ${message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Solution effectiveness prediction
// ---------------------------------------------------------------------------

/**
 * Predict how effective a solution will be for a problem.
 *
 * @param backend - Database backend
 * @param problemDescription - Description of the problem
 * @param solutionId - Solution being considered
 * @returns Predicted effectiveness score (0.0 to 1.0)
 */
export async function predictSolutionEffectiveness(
  backend: GraphBackend,
  problemDescription: string,
  solutionId: string
): Promise<number> {
  console.info(`Predicting effectiveness of solution ${solutionId}`);

  const solutionQuery = `
    MATCH (s:Memory {id: $solution_id})
    OPTIONAL MATCH (s)-[:RESULTED_IN]->(o:Outcome)
    RETURN s.effectiveness as base_effectiveness,
           s.confidence as confidence,
           count(o) as outcomes,
           sum(CASE WHEN o.success THEN 1 ELSE 0 END) as successes
  `;

  try {
    const result = await backend.executeQuery(solutionQuery, { solution_id: solutionId });
    if (!result || result.length === 0) {
      return 0.5;
    }

    const record = result[0];
    const baseEffectiveness = (record["base_effectiveness"] as number) ?? 0.5;
    const confidence = (record["confidence"] as number) ?? 0.5;

    if (confidence > 0.7) {
      return baseEffectiveness;
    }

    // Extract entities from problem description (lazy import to avoid circular deps)
    const { extractEntities } = await import("../intelligence/entity-extraction.js");
    const entities = extractEntities(problemDescription);
    const entityTexts = entities.map((e) => e.text);

    if (entityTexts.length === 0) {
      return baseEffectiveness;
    }

    const entityMatchQuery = `
      MATCH (s:Memory {id: $solution_id})-[:MENTIONS]->(e:Entity)
      WHERE e.text IN $entity_texts
      RETURN count(DISTINCT e) as matched_entities
    `;

    const entityResult = await backend.executeQuery(entityMatchQuery, {
      solution_id: solutionId,
      entity_texts: entityTexts,
    });

    const matchedCount =
      entityResult && entityResult.length > 0
        ? ((entityResult[0]["matched_entities"] as number) ?? 0)
        : 0;
    const entityMatchScore = Math.min(matchedCount / entityTexts.length, 1.0);

    const predicted = baseEffectiveness * 0.7 + entityMatchScore * 0.3;

    console.info(
      `Predicted effectiveness: ${predicted.toFixed(2)} (base: ${baseEffectiveness.toFixed(2)}, match: ${entityMatchScore.toFixed(2)})`
    );
    return predicted;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error predicting effectiveness: ${message}`);
    return 0.5;
  }
}

// ---------------------------------------------------------------------------
// Learning path recommendations
// ---------------------------------------------------------------------------

/**
 * Recommend learning paths for a topic.
 *
 * @param backend - Database backend
 * @param topic - Topic to learn about
 * @param maxPaths - Maximum number of paths to return
 * @returns List of recommended learning paths
 */
export async function recommendLearningPaths(
  backend: GraphBackend,
  topic: string,
  maxPaths = 3
): Promise<LearningPath[]> {
  console.info(`Recommending learning paths for topic: ${topic}`);

  const topicQuery = `
    MATCH (m:Memory)
    WHERE m.content CONTAINS $topic
       OR any(tag IN m.tags WHERE tag CONTAINS $topic_lower)
       OR m.title CONTAINS $topic
    WITH m
    LIMIT 20
    MATCH path = (m)-[:BUILDS_ON|GENERALIZES|SPECIALIZES*1..3]-(related:Memory)
    RETURN m, collect(DISTINCT related) as related_memories,
           length(path) as path_length
    ORDER BY path_length DESC
    LIMIT $max_paths
  `;

  try {
    const results = await backend.executeQuery(topicQuery, {
      topic,
      topic_lower: topic.toLowerCase(),
      max_paths: maxPaths,
    });

    const paths: LearningPath[] = [];

    for (let idx = 0; idx < (results ?? []).length; idx++) {
      const record = results[idx];
      const startMemory = record["m"] as Record<string, unknown>;
      const related = (record["related_memories"] as Record<string, unknown>[]) ?? [];

      const steps: Array<Record<string, string | number>> = [
        {
          memory_id: startMemory["id"] as string,
          title: startMemory["title"] as string,
          type: startMemory["type"] as string,
          step: 1,
        },
      ];

      const relatedSlice = related.slice(0, 5);
      for (let stepIdx = 0; stepIdx < relatedSlice.length; stepIdx++) {
        const mem = relatedSlice[stepIdx];
        steps.push({
          memory_id: mem["id"] as string,
          title: mem["title"] as string,
          type: mem["type"] as string,
          step: stepIdx + 2,
        });
      }

      const allMems = [startMemory, ...relatedSlice];
      const totalEffectiveness = allMems.reduce(
        (sum, mem) => sum + ((mem["effectiveness"] as number) ?? 0.5),
        0
      );
      const avgEffectiveness = totalEffectiveness / steps.length;

      paths.push({
        path_id: `path_${idx + 1}`,
        topic,
        steps,
        total_memories: steps.length,
        estimated_value: avgEffectiveness,
      });
    }

    console.info(`Recommended ${paths.length} learning paths`);
    return paths;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error recommending learning paths: ${message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Knowledge gap identification
// ---------------------------------------------------------------------------

/**
 * Identify knowledge gaps in the memory graph.
 *
 * @param backend - Database backend
 * @param project - Optional project filter
 * @param minGapSeverity - Minimum severity ("low", "medium", "high")
 * @returns List of identified knowledge gaps
 */
export async function identifyKnowledgeGaps(
  backend: GraphBackend,
  project?: string | null,
  minGapSeverity = "low"
): Promise<KnowledgeGap[]> {
  console.info(`Identifying knowledge gaps for project: ${project ?? "all"}`);

  const gaps: KnowledgeGap[] = [];

  // Find problems without solutions
  let unsolvedQuery = `
    MATCH (p:Memory {type: 'problem'})
    WHERE NOT (p)<-[:SOLVES|ADDRESSES]-(:Memory)
  `;
  if (project) {
    unsolvedQuery += "AND (p.context CONTAINS $project)\n";
  }
  unsolvedQuery += `
    RETURN p.id as id, p.title as title, p.tags as tags,
           p.created_at as created_at
    ORDER BY p.created_at DESC
    LIMIT 10
  `;

  try {
    const params: Record<string, unknown> = project ? { project } : {};
    const results = await backend.executeQuery(unsolvedQuery, params);

    for (const record of results ?? []) {
      const createdAt = parseDatetime(record["created_at"] as string);
      const ageDays = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      let severity: string;
      if (ageDays > 30) severity = "high";
      else if (ageDays > 7) severity = "medium";
      else severity = "low";

      gaps.push({
        gap_id: record["id"] as string,
        topic: (record["title"] as string) ?? "",
        description: `Unsolved problem (${ageDays} days old)`,
        severity,
        related_memories: 0,
        suggestions: ["Create a solution memory", "Link to existing solutions"],
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error finding unsolved problems: ${message}`);
  }

  // Find sparse entities
  const sparseQuery = `
    MATCH (e:Entity)<-[:MENTIONS]-(m:Memory)
    WITH e, count(m) as mention_count
    WHERE mention_count <= 2
      AND mention_count > 0
    RETURN e.text as entity, e.entity_type as type, mention_count
    LIMIT 10
  `;

  try {
    const results = await backend.executeQuery(sparseQuery, {});
    for (const record of results ?? []) {
      const entity = record["entity"] as string;
      const mentionCount = (record["mention_count"] as number) ?? 0;
      gaps.push({
        gap_id: `sparse_${entity}`,
        topic: entity,
        description: `Technology/concept mentioned only ${mentionCount} time(s)`,
        severity: "low",
        related_memories: mentionCount,
        suggestions: [`Create documentation for ${entity}`, "Add code patterns"],
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error finding sparse entities: ${message}`);
  }

  // Filter by severity
  const severityLevels: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const threshold = severityLevels[minGapSeverity] ?? 1;

  const filteredGaps = gaps.filter(
    (gap) => (severityLevels[gap.severity] ?? 0) >= threshold
  );

  console.info(`Identified ${filteredGaps.length} knowledge gaps`);
  return filteredGaps;
}

// ---------------------------------------------------------------------------
// Memory ROI tracking
// ---------------------------------------------------------------------------

/**
 * Track return on investment for a memory.
 *
 * @param backend - Database backend
 * @param memoryId - Memory to track
 * @returns MemoryROI metrics, or null if not found
 */
export async function trackMemoryROI(
  backend: GraphBackend,
  memoryId: string
): Promise<MemoryROI | null> {
  console.info(`Tracking ROI for memory ${memoryId}`);

  const roiQuery = `
    MATCH (m:Memory {id: $memory_id})
    OPTIONAL MATCH (m)-[:RESULTED_IN]->(o:Outcome)
    RETURN m.id as id, m.title as title, m.created_at as created_at,
           m.usage_count as usage_count, m.last_accessed as last_accessed,
           count(o) as total_outcomes,
           sum(CASE WHEN o.success THEN 1 ELSE 0 END) as successful_outcomes
  `;

  try {
    const result = await backend.executeQuery(roiQuery, { memory_id: memoryId });
    if (!result || result.length === 0) {
      return null;
    }

    const record = result[0];
    const usageCount = (record["usage_count"] as number) ?? 0;
    const totalOutcomes = (record["total_outcomes"] as number) ?? 0;
    const successfulOutcomes = (record["successful_outcomes"] as number) ?? 0;

    const successRate = totalOutcomes > 0 ? successfulOutcomes / totalOutcomes : 0.0;

    const usageScore = Math.min(usageCount / 10.0, 1.0);
    const valueScore = usageScore * 0.5 + successRate * 0.5;

    const lastAccessedRaw = record["last_accessed"];
    let lastUsed: Date | null = null;
    if (lastAccessedRaw) {
      try {
        lastUsed = parseDatetime(lastAccessedRaw as string);
      } catch {
        lastUsed = null;
      }
    }

    return {
      memory_id: record["id"] as string,
      title: (record["title"] as string) ?? "",
      creation_date: parseDatetime(record["created_at"] as string),
      times_accessed: usageCount,
      times_helpful: successfulOutcomes,
      success_rate: successRate,
      value_score: valueScore,
      last_used: lastUsed,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error tracking ROI: ${message}`);
    return null;
  }
}
