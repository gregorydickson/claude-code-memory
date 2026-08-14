/**
 * Outcome Learning and Effectiveness Tracking for MemoryGraph.
 *
 * Port of the Python `memorygraph.proactive.outcome_learning` module.
 * Tracks solution effectiveness and learns from outcomes:
 * - Record solution outcomes (success/failure)
 * - Update effectiveness scores
 * - Propagate learning to patterns
 * - Decay old outcomes (design only)
 */

import type { GraphBackend } from "../backends/index.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Outcome of applying a memory (solution, pattern, etc.). */
export interface Outcome {
  outcome_id: string;
  memory_id: string;
  success: boolean;
  description: string;
  context?: Record<string, unknown> | null;
  timestamp: Date;
  impact: number;
}

/** Effectiveness score for a memory. */
export interface EffectivenessScore {
  memory_id: string;
  total_uses: number;
  successful_uses: number;
  failed_uses: number;
  effectiveness: number;
  confidence: number;
  last_updated: Date;
}

// ---------------------------------------------------------------------------
// Record outcome
// ---------------------------------------------------------------------------

/**
 * Record the outcome of using a memory.
 *
 * Creates an Outcome node linked to the memory and updates effectiveness scores.
 *
 * @param backend - Database backend
 * @param memoryId - ID of memory that was used
 * @param outcomeDescription - Description of what happened
 * @param success - Whether the outcome was successful
 * @param context - Additional context about the outcome
 * @param impact - How significant this outcome was (0.0 to 1.0)
 * @returns True if outcome was recorded successfully
 */
export async function recordOutcome(
  backend: GraphBackend,
  memoryId: string,
  outcomeDescription: string,
  success: boolean,
  context?: Record<string, unknown> | null,
  impact = 1.0
): Promise<boolean> {
  console.info(`Recording outcome for memory ${memoryId}: success=${success}`);

  const outcomeId = `outcome_${randomUUID()}`;

  const createOutcomeQuery = `
    MATCH (m:Memory {id: $memory_id})
    CREATE (o:Outcome {
        id: $outcome_id,
        memory_id: $memory_id,
        success: $success,
        description: $description,
        context: $context,
        timestamp: $timestamp,
        impact: $impact
    })
    CREATE (m)-[:RESULTED_IN]->(o)
    RETURN o.id as id
  `;

  try {
    const result = await backend.executeQuery(
      createOutcomeQuery,
      {
        memory_id: memoryId,
        outcome_id: outcomeId,
        success,
        description: outcomeDescription,
        context: context ? JSON.stringify(context) : null,
        timestamp: new Date().toISOString(),
        impact,
      },
      true
    );

    if (!result || result.length === 0) {
      console.error(`Failed to create outcome for memory ${memoryId}`);
      return false;
    }

    console.debug(`Created outcome ${outcomeId}`);

    await updateMemoryEffectiveness(backend, memoryId, success, impact);
    await propagateToPatterns(backend, memoryId, success, impact);

    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error recording outcome: ${message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal: update memory effectiveness
// ---------------------------------------------------------------------------

/**
 * Update effectiveness score for a memory based on outcome.
 * Uses Bayesian-style updating to incorporate new evidence.
 */
async function updateMemoryEffectiveness(
  backend: GraphBackend,
  memoryId: string,
  success: boolean,
  impact: number
): Promise<void> {
  console.debug(`Updating effectiveness for memory ${memoryId}`);

  const statsQuery = `
    MATCH (m:Memory {id: $memory_id})
    OPTIONAL MATCH (m)-[:RESULTED_IN]->(o:Outcome)
    RETURN m.effectiveness as current_effectiveness,
           m.usage_count as usage_count,
           count(o) as total_outcomes,
           sum(CASE WHEN o.success THEN 1 ELSE 0 END) as successful_outcomes
  `;

  try {
    const result = await backend.executeQuery(statsQuery, { memory_id: memoryId });
    if (!result || result.length === 0) {
      return;
    }

    const record = result[0];
    const usageCount = (record["usage_count"] as number) ?? 0;
    const totalOutcomes = (record["total_outcomes"] as number) ?? 0;
    const successfulOutcomes = (record["successful_outcomes"] as number) ?? 0;

    let newEffectiveness: number;
    if (totalOutcomes > 0) {
      const successRate = successfulOutcomes / totalOutcomes;
      newEffectiveness = successRate * (1 - impact) + (success ? 1.0 : 0.0) * impact;
    } else {
      newEffectiveness = success ? 1.0 : 0.0;
    }

    newEffectiveness = Math.max(0.0, Math.min(1.0, newEffectiveness));

    const confidence = Math.min(0.9, 0.3 + (totalOutcomes / 20.0) * 0.6);

    const updateQuery = `
      MATCH (m:Memory {id: $memory_id})
      SET m.effectiveness = $effectiveness,
          m.confidence = $confidence,
          m.usage_count = $usage_count + 1,
          m.last_accessed = $timestamp
      RETURN m.effectiveness as effectiveness
    `;

    await backend.executeQuery(
      updateQuery,
      {
        memory_id: memoryId,
        effectiveness: newEffectiveness,
        confidence,
        usage_count: usageCount,
        timestamp: new Date().toISOString(),
      },
      true
    );

    console.info(
      `Updated effectiveness for ${memoryId}: ${newEffectiveness.toFixed(2)} (confidence: ${confidence.toFixed(2)})`
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error updating memory effectiveness: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Internal: propagate to patterns
// ---------------------------------------------------------------------------

/**
 * Propagate outcome learning to related patterns.
 * If a solution worked, increase confidence in related patterns.
 */
async function propagateToPatterns(
  backend: GraphBackend,
  memoryId: string,
  success: boolean,
  impact: number
): Promise<void> {
  console.debug(`Propagating outcome to related patterns for memory ${memoryId}`);

  const patternQuery = `
    MATCH (m:Memory {id: $memory_id})
    MATCH (m)-[:DERIVED_FROM|USES|APPLIES]->(p:Memory {type: 'code_pattern'})
    RETURN p.id as pattern_id, p.effectiveness as effectiveness
  `;

  try {
    const results = await backend.executeQuery(patternQuery, { memory_id: memoryId });
    for (const record of results ?? []) {
      const patternId = record["pattern_id"] as string;
      await updatePatternEffectiveness(backend, patternId, success, impact * 0.5);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error propagating to patterns: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Update pattern effectiveness
// ---------------------------------------------------------------------------

/**
 * Update effectiveness of a pattern based on usage outcome.
 *
 * @param backend - Database backend
 * @param patternId - ID of pattern to update
 * @param success - Whether usage was successful
 * @param impact - Impact weight (0.0 to 1.0)
 * @returns True if updated successfully
 */
export async function updatePatternEffectiveness(
  backend: GraphBackend,
  patternId: string,
  success: boolean,
  impact = 1.0
): Promise<boolean> {
  console.info(
    `Updating pattern ${patternId} effectiveness: success=${success}, impact=${impact}`
  );

  const statsQuery = `
    MATCH (p:Memory {id: $pattern_id, type: 'code_pattern'})
    OPTIONAL MATCH (p)-[:DERIVED_FROM|USES|APPLIES]-(m:Memory)-[:RESULTED_IN]->(o:Outcome)
    RETURN p.effectiveness as current_effectiveness,
           p.confidence as current_confidence,
           p.usage_count as usage_count,
           count(o) as total_outcomes,
           sum(CASE WHEN o.success THEN 1 ELSE 0 END) as successful_outcomes
  `;

  try {
    const result = await backend.executeQuery(statsQuery, { pattern_id: patternId });
    if (!result || result.length === 0) {
      console.warn(`Pattern ${patternId} not found`);
      return false;
    }

    const record = result[0];
    const currentEffectiveness = (record["current_effectiveness"] as number) ?? 0.5;
    const currentConfidence = (record["current_confidence"] as number) ?? 0.5;
    const totalOutcomes = (record["total_outcomes"] as number) ?? 0;
    const successfulOutcomes = (record["successful_outcomes"] as number) ?? 0;

    const dampening = 0.3;

    let adjustment: number;
    if (totalOutcomes > 0) {
      const successRate = successfulOutcomes / totalOutcomes;
      adjustment = ((success ? 1.0 : 0.0) - successRate) * impact * dampening;
    } else {
      adjustment = ((success ? 1.0 : 0.0) - currentEffectiveness) * impact * dampening;
    }

    const newEffectiveness = Math.max(0.0, Math.min(1.0, currentEffectiveness + adjustment));
    const newConfidence = Math.min(0.95, currentConfidence + 0.02);

    const updateQuery = `
      MATCH (p:Memory {id: $pattern_id})
      SET p.effectiveness = $effectiveness,
          p.confidence = $confidence,
          p.usage_count = p.usage_count + 1,
          p.last_accessed = $timestamp
      RETURN p.effectiveness as effectiveness
    `;

    await backend.executeQuery(
      updateQuery,
      {
        pattern_id: patternId,
        effectiveness: newEffectiveness,
        confidence: newConfidence,
        timestamp: new Date().toISOString(),
      },
      true
    );

    console.info(`Updated pattern ${patternId} effectiveness: ${newEffectiveness.toFixed(2)}`);
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error updating pattern effectiveness: ${message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Calculate effectiveness score
// ---------------------------------------------------------------------------

/**
 * Calculate detailed effectiveness score for a memory.
 *
 * @param backend - Database backend
 * @param memoryId - ID of memory to analyze
 * @returns EffectivenessScore with statistics, or null if not found
 */
export async function calculateEffectivenessScore(
  backend: GraphBackend,
  memoryId: string
): Promise<EffectivenessScore | null> {
  console.debug(`Calculating effectiveness score for ${memoryId}`);

  const query = `
    MATCH (m:Memory {id: $memory_id})
    OPTIONAL MATCH (m)-[:RESULTED_IN]->(o:Outcome)
    RETURN m.effectiveness as effectiveness,
           m.confidence as confidence,
           count(o) as total_outcomes,
           sum(CASE WHEN o.success THEN 1 ELSE 0 END) as successful_outcomes,
           sum(CASE WHEN NOT o.success THEN 1 ELSE 0 END) as failed_outcomes
  `;

  try {
    const result = await backend.executeQuery(query, { memory_id: memoryId });
    if (!result || result.length === 0) {
      return null;
    }

    const record = result[0];

    return {
      memory_id: memoryId,
      total_uses: (record["total_outcomes"] as number) ?? 0,
      successful_uses: (record["successful_outcomes"] as number) ?? 0,
      failed_uses: (record["failed_outcomes"] as number) ?? 0,
      effectiveness: (record["effectiveness"] as number) ?? 0.5,
      confidence: (record["confidence"] as number) ?? 0.5,
      last_updated: new Date(),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error calculating effectiveness score: ${message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Decay mechanism design
// ---------------------------------------------------------------------------

/**
 * Design for effectiveness decay mechanism (not yet implemented).
 *
 * Old outcomes should have less weight over time. This function documents
 * the design for a background job that would implement decay.
 *
 * @returns Design specification for decay mechanism
 */
export function designDecayMechanism(): Record<string, unknown> {
  return {
    mechanism: "exponential_decay",
    half_life_days: 180,
    decay_function: "weight = exp(-age_in_days / half_life)",
    run_frequency: "weekly",
    implementation: "background_job",
    status: "designed_not_implemented",
    priority: "medium",
    estimated_effort: "4 hours",
  };
}
