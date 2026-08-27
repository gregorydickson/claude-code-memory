/**
 * Shared Cypher implementation of getRecentActivity for FalkorDB and Bolt
 * backends (VAL-REVIEW-017).
 *
 * Previously only the sqlite and cloud backends implemented getRecentActivity;
 * on the default falkordblite backend the MemoryDatabase wrapper fell back
 * to an all-zeros stub, so `memorygraph activity` silently reported an empty
 * summary. This module ports the sqlite implementation's exact output shape
 * (including the VAL-LOCAL-015 cap_message surfacing) to Cypher.
 *
 * FalkorDB v4.16.3 constraint (M14): `EXISTS { MATCH ... }` subqueries are
 * unsupported, so "unsolved problem" is computed with OPTIONAL MATCH + count.
 */

import type { Memory } from "../models.ts";
import { parseMemoryFromProperties } from "../utils/memory-parser.ts";

const RECENT_CAP = 50;
const UNRESOLVED_CAP = 20;

type QueryFn = (
  query: string,
  parameters?: Record<string, unknown>,
  write?: boolean
) => Promise<Record<string, unknown>[]>;

export async function runRecentActivity(
  executeQuery: QueryFn,
  source: string,
  days = 7,
  project?: string | null
): Promise<Record<string, unknown>> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();

  const projectClause = project ? " AND m.context_project_path = $project" : "";
  const activityParams: Record<string, unknown> = { cutoff: cutoffIso };
  if (project) activityParams["project"] = project;

  const recentResult = await executeQuery(
    `
    MATCH (m:Memory)
    WHERE m.created_at >= $cutoff${projectClause}
    RETURN m
    ORDER BY m.created_at DESC
    LIMIT ${RECENT_CAP}
    `,
    activityParams,
    false
  );
  const recentMemories = recentResult
    .map((r) => parseMemoryFromProperties(r["m"] as Record<string, unknown>, source))
    .filter((m): m is Memory => m !== null);

  const totalResult = await executeQuery(
    `
    MATCH (m:Memory)
    WHERE m.created_at >= $cutoff${projectClause}
    RETURN COUNT(m) as count
    `,
    activityParams,
    false
  );
  const recentTotal = (totalResult[0]?.["count"] as number) ?? 0;

  const byType: Record<string, number> = {};
  for (const mem of recentMemories) {
    byType[mem.type] = (byType[mem.type] ?? 0) + 1;
  }

  // Problems with no SOLVES edge pointing at them (OPTIONAL MATCH + count:
  // EXISTS { MATCH } is unsupported on FalkorDB v4.16.3 — see M14).
  const unresolvedResult = await executeQuery(
    `
    MATCH (p:Memory {type: 'problem'})
    OPTIONAL MATCH (p)<-[solved:SOLVES]-(s:Memory)
    WITH p, count(DISTINCT solved) as solver_count
    WHERE solver_count = 0
    RETURN p
    ORDER BY p.importance DESC
    LIMIT ${UNRESOLVED_CAP}
    `,
    {},
    false
  );
  const unresolvedProblems = unresolvedResult
    .map((r) => parseMemoryFromProperties(r["p"] as Record<string, unknown>, source))
    .filter((m): m is Memory => m !== null);

  const unresolvedTotalResult = await executeQuery(
    `
    MATCH (p:Memory {type: 'problem'})
    OPTIONAL MATCH (p)<-[solved:SOLVES]-(s:Memory)
    WITH p, count(DISTINCT solved) as solver_count
    WHERE solver_count = 0
    RETURN COUNT(p) as count
    `,
    {},
    false
  );
  const unresolvedTotal = (unresolvedTotalResult[0]?.["count"] as number) ?? 0;

  const recentCapped = recentTotal > recentMemories.length;
  const unresolvedCapped = unresolvedTotal > unresolvedProblems.length;

  const capParts: string[] = [];
  if (recentCapped) {
    capParts.push(
      `Recent memories capped at ${RECENT_CAP} (${recentTotal} total in the last ${days} days)`
    );
  }
  if (unresolvedCapped) {
    capParts.push(`Unresolved problems capped at ${UNRESOLVED_CAP} (${unresolvedTotal} total)`);
  }
  const capMessage = capParts.length > 0 ? capParts.join("; ") : null;

  return {
    total_count: recentMemories.length,
    memories_by_type: byType,
    recent_memories: recentMemories,
    recent_memories_total: recentTotal,
    recent_memories_capped: recentCapped,
    unresolved_problems: unresolvedProblems,
    unresolved_problems_total: unresolvedTotal,
    unresolved_problems_capped: unresolvedCapped,
    cap_message: capMessage,
    days,
    project,
  };
}
