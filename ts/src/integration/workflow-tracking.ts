/**
 * Workflow Memory Tools for Claude Code Integration.
 *
 * Port of the Python `memorygraph.integration.workflow_tracking` module.
 *
 * Tracks development workflows and provides intelligent suggestions:
 * - Workflow action tracking
 * - Session state management
 * - Workflow suggestions based on past successes
 * - Workflow optimization recommendations
 */

import { randomUUID } from "node:crypto";

import type { GraphBackend } from "../backends/index.js";
import {
  createMemory,
  createRelationshipProperties,
  MemoryType,
  SearchQuerySchema,
  type Memory,
} from "../models.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface WorkflowAction {
  action_id: string;
  session_id: string;
  action_type: string;
  action_data: Record<string, unknown>;
  timestamp: Date;
  duration_seconds?: number | null;
  success: boolean;
}

export interface WorkflowSuggestion {
  suggestion_id: string;
  workflow_name: string;
  description: string;
  steps: string[];
  success_rate: number;
  relevance_score: number;
  last_used?: Date | null;
}

export interface Recommendation {
  recommendation_id: string;
  recommendation_type: string;
  title: string;
  description: string;
  impact: string;
  evidence: string[];
}

export interface SessionState {
  session_id: string;
  start_time: Date;
  last_activity: Date;
  current_task?: string | null;
  open_problems: string[];
  next_steps: string[];
  context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMemory(
  type: string,
  title: string,
  content: string,
  metadata: Record<string, unknown>,
  id?: string
): Memory {
  return createMemory({
    id: id ?? randomUUID(),
    type,
    title,
    content,
    context: {
      additional_metadata: metadata,
    },
  });
}

function getMetadata(memory: Memory): Record<string, unknown> {
  return (memory.context?.additional_metadata as Record<string, unknown>) ?? {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Track a workflow action in the current session.
 */
export async function trackWorkflow(
  backend: GraphBackend,
  sessionId: string,
  actionType: string,
  actionData: Record<string, unknown>,
  success = true,
  durationSeconds?: number | null
): Promise<string> {
  const action: WorkflowAction = {
    action_id: randomUUID(),
    session_id: sessionId,
    action_type: actionType,
    action_data: actionData,
    success,
    duration_seconds: durationSeconds ?? null,
    timestamp: new Date(),
  };

  const metadata: Record<string, unknown> = {
    session_id: sessionId,
    action_type: actionType,
    action_data: actionData,
    success,
    duration_seconds: durationSeconds ?? null,
    timestamp: action.timestamp.toISOString(),
  };

  let content = `Session: ${sessionId}\nAction: ${actionType}\nSuccess: ${success}`;
  if (durationSeconds != null) content += `\nDuration: ${durationSeconds}s`;

  const memory = buildMemory(
    MemoryType.WORKFLOW,
    `Action: ${actionType}`,
    content,
    metadata,
    action.action_id
  );

  const memoryId = await backend.storeMemory(memory);

  // Create or get session entity
  try {
    await backend.executeQuery(
      `
      MERGE (s:Entity {id: $session_id, type: 'session'})
      ON CREATE SET s.created_at = $now, s.start_time = $now
      SET s.last_activity = $now
      RETURN s.id as id
      `,
      { session_id: sessionId, now: new Date().toISOString() },
      true
    );

    // Link action to session
    await backend.createRelationship(
      memoryId,
      sessionId,
      "IN_SESSION",
      createRelationshipProperties({ strength: 1.0 })
    );

    // Link to previous action (workflow sequence)
    const previousActions = await backend.executeQuery(
      `
      MATCH (a:Memory {type: 'workflow'})-[:IN_SESSION]->(s:Entity {id: $session_id})
      WHERE a.id <> $current_id
      RETURN a.id as id, a.created_at as created_at
      ORDER BY a.created_at DESC
      LIMIT 1
      `,
      { session_id: sessionId, current_id: memoryId }
    );

    if (previousActions && previousActions.length > 0) {
      const prevId = previousActions[0]!["id"] as string;
      await backend.createRelationship(
        memoryId,
        prevId,
        "FOLLOWS",
        createRelationshipProperties({ strength: 0.8 })
      );
    }
  } catch (err) {
    console.warn(`Failed to link workflow action to session:`, err);
  }

  return memoryId;
}

/**
 * Suggest workflows based on current context and past successes.
 */
export async function suggestWorkflow(
  backend: GraphBackend,
  currentContext: Record<string, unknown>,
  maxSuggestions = 5
): Promise<WorkflowSuggestion[]> {
  const suggestions: WorkflowSuggestion[] = [];

  // Extract context elements for matching
  let taskKeywords: string[] = [];
  if (typeof currentContext["task"] === "string") {
    taskKeywords = (currentContext["task"] as string).toLowerCase().split(/\s+/);
  }

  // Find similar past workflows by searching workflow memories
  let workflowMemories: Memory[] = [];
  try {
    workflowMemories = await backend.searchMemories(
      SearchQuerySchema.parse({
        memory_types: [MemoryType.WORKFLOW],
        limit: 100,
        include_relationships: false,
      })
    );
  } catch (err) {
    console.warn(`Failed to search for past workflows:`, err);
    return suggestions;
  }

  // Group workflow memories by session and analyze sequences
  const sessionActions: Record<string, Memory[]> = {};
  for (const mem of workflowMemories) {
    const meta = getMetadata(mem);
    const sid = meta["session_id"] as string | undefined;
    if (!sid) continue;
    if (!(sid in sessionActions)) sessionActions[sid] = [];
    sessionActions[sid]!.push(mem);
  }

  // Analyze workflow patterns - build signatures from action sequences
  const workflowPatterns: Record<
    string,
    {
      sequence: string;
      count: number;
      successes: number;
      last_used: Date | null;
      examples: string[];
    }
  > = {};

  for (const [, actions] of Object.entries(sessionActions)) {
    // Filter successful actions and sort by created_at
    const successful = actions
      .filter((a) => getMetadata(a)["success"] === true)
      .sort((a, b) => {
        const ta = new Date(a.created_at as string).getTime();
        const tb = new Date(b.created_at as string).getTime();
        return ta - tb;
      });

    if (successful.length < 3) continue;

    const actionSequence = successful
      .slice(0, 10)
      .map((a) => (getMetadata(a)["action_type"] as string) ?? "unknown")
      .join(" -> ");

    if (!(actionSequence in workflowPatterns)) {
      workflowPatterns[actionSequence] = {
        sequence: actionSequence,
        count: 0,
        successes: 0,
        last_used: null,
        examples: [],
      };
    }

    const pat = workflowPatterns[actionSequence]!;
    pat.count += 1;
    pat.successes += 1; // Already filtered for success

    const lastActivity = successful[successful.length - 1]!.created_at;
    if (lastActivity) {
      const lastDate = new Date(lastActivity as string);
      if (!pat.last_used || lastDate > pat.last_used) {
        pat.last_used = lastDate;
      }
    }
  }

  // Convert patterns to suggestions
  for (const [patternKey, patternData] of Object.entries(workflowPatterns)) {
    if (patternData.count < 2) continue;

    const successRate = patternData.successes / patternData.count;

    // Calculate relevance score
    let relevanceScore = 0.5;
    if (taskKeywords.length > 0) {
      for (const keyword of taskKeywords) {
        if (patternKey.toLowerCase().includes(keyword)) {
          relevanceScore += 0.1;
        }
      }
    }
    relevanceScore = Math.min(relevanceScore, 1.0);

    const steps = patternKey.split(" -> ");

    const suggestion: WorkflowSuggestion = {
      suggestion_id: randomUUID(),
      workflow_name: `Workflow: ${steps.slice(0, 3).join(" -> ")}...`,
      description: `Common workflow seen ${patternData.count} times`,
      steps,
      success_rate: successRate,
      relevance_score: relevanceScore,
      last_used: patternData.last_used,
    };

    suggestions.push(suggestion);
  }

  // Sort by combined score
  suggestions.sort(
    (a, b) =>
      b.success_rate * 0.6 + b.relevance_score * 0.4 -
      (a.success_rate * 0.6 + a.relevance_score * 0.4)
  );

  return suggestions.slice(0, maxSuggestions);
}

/**
 * Analyze workflow and provide optimization recommendations.
 */
export async function optimizeWorkflow(
  backend: GraphBackend,
  sessionId: string
): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Get session actions
  let actions: Memory[] = [];
  try {
    actions = await backend.searchMemories(
      SearchQuerySchema.parse({
        memory_types: [MemoryType.WORKFLOW],
        limit: 1000,
        include_relationships: false,
      })
    );
  } catch (err) {
    console.warn(`Failed to fetch session actions:`, err);
    return recommendations;
  }

  // Filter to this session
  const sessionActions = actions.filter(
    (a) => getMetadata(a)["session_id"] === sessionId
  );

  if (sessionActions.length === 0) return recommendations;

  // Analyze for bottlenecks
  const slowActions = sessionActions.filter((a) => {
    const dur = getMetadata(a)["duration_seconds"];
    return typeof dur === "number" && dur > 30;
  });

  if (slowActions.length > 0) {
    recommendations.push({
      recommendation_id: randomUUID(),
      recommendation_type: "performance",
      title: "Slow actions detected",
      description: `Found ${slowActions.length} actions taking over 30 seconds. Consider optimizing these operations or running them in background.`,
      impact: "medium",
      evidence: slowActions
        .slice(0, 3)
        .map((a) => {
          const meta = getMetadata(a);
          return `Action ${meta["action_type"]} took ${meta["duration_seconds"]}s`;
        }),
    });
  }

  // Analyze for repeated failures
  const failedActions = sessionActions.filter((a) => getMetadata(a)["success"] !== true);

  if (failedActions.length >= 3) {
    const errorTypes: Record<string, number> = {};
    for (const action of failedActions) {
      const actionType = (getMetadata(action)["action_type"] as string) ?? "unknown";
      errorTypes[actionType] = (errorTypes[actionType] ?? 0) + 1;
    }

    for (const [actionType, count] of Object.entries(errorTypes)) {
      if (count >= 2) {
        recommendations.push({
          recommendation_id: randomUUID(),
          recommendation_type: "error_pattern",
          title: `Repeated failures in ${actionType}`,
          description: `Action type '${actionType}' failed ${count} times. This may indicate a systematic issue that needs addressing.`,
          impact: "high",
          evidence: [`Failed ${count} times in this session`],
        });
      }
    }
  }

  // Analyze action sequence for inefficiencies
  const actionTypes = sessionActions
    .sort((a, b) => {
      const ta = new Date(a.created_at as string).getTime();
      const tb = new Date(b.created_at as string).getTime();
      return ta - tb;
    })
    .map((a) => (getMetadata(a)["action_type"] as string) ?? "unknown");

  for (let i = 0; i < actionTypes.length - 2; i++) {
    if (
      actionTypes[i] === actionTypes[i + 2] &&
      actionTypes[i] !== actionTypes[i + 1]
    ) {
      recommendations.push({
        recommendation_id: randomUUID(),
        recommendation_type: "workflow_pattern",
        title: "Inefficient back-and-forth pattern detected",
        description: `Detected switching between ${actionTypes[i]} and ${actionTypes[i + 1]} multiple times. Consider batching similar operations together.`,
        impact: "low",
        evidence: [`Pattern: ${actionTypes[i]} -> ${actionTypes[i + 1]} -> ${actionTypes[i]}`],
      });
      break; // Only report once
    }
  }

  // Check for long sessions without breaks
  if (sessionActions.length > 50) {
    recommendations.push({
      recommendation_id: randomUUID(),
      recommendation_type: "productivity",
      title: "Long session detected",
      description: `This session has ${sessionActions.length} actions. Consider taking breaks for better productivity and code quality.`,
      impact: "low",
      evidence: [`Session has ${sessionActions.length} actions`],
    });
  }

  return recommendations;
}

/**
 * Get current state of a session for continuity.
 */
export async function getSessionState(
  backend: GraphBackend,
  sessionId: string
): Promise<SessionState | null> {
  // Get session entity via Cypher
  let sessionData: Record<string, unknown> | null = null;
  try {
    const result = await backend.executeQuery(
      `
      MATCH (s:Entity {id: $session_id, type: 'session'})
      RETURN s.created_at as start_time,
             s.last_activity as last_activity,
             s.current_task as current_task,
             s.context as context
      `,
      { session_id: sessionId }
    );
    if (result && result.length > 0) {
      sessionData = result[0]!;
    }
  } catch (err) {
    console.warn(`Failed to fetch session entity:`, err);
  }

  if (!sessionData) return null;

  // Get recent actions
  let recentActions: Memory[] = [];
  try {
    const allWorkflows = await backend.searchMemories(
      SearchQuerySchema.parse({
        memory_types: [MemoryType.WORKFLOW],
        limit: 100,
        include_relationships: false,
      })
    );
    recentActions = allWorkflows
      .filter((a) => getMetadata(a)["session_id"] === sessionId)
      .sort((a, b) => {
        const ta = new Date(b.created_at as string).getTime();
        const tb = new Date(a.created_at as string).getTime();
        return ta - tb;
      })
      .slice(0, 5);
  } catch (err) {
    console.warn(`Failed to fetch recent actions:`, err);
  }

  // Find open problems (errors without solutions) via Cypher
  let openProblems: string[] = [];
  try {
    const result = await backend.executeQuery(
      `
      MATCH (e:Memory {type: 'error'})<-[:EXHIBITS]-(a:Memory {type: 'workflow'})
      WHERE (a)-[:IN_SESSION]->(:Entity {id: $session_id})
      AND NOT (e)<-[:SOLVES]-(:Memory)
      RETURN DISTINCT e.title as problem
      LIMIT 10
      `,
      { session_id: sessionId }
    );
    if (result) {
      openProblems = result.map((r) => r["problem"] as string);
    }
  } catch (err) {
    console.warn(`Failed to fetch open problems:`, err);
  }

  // Suggest next steps based on recent actions
  const nextSteps: string[] = [];
  if (recentActions.length > 0) {
    const lastAction = recentActions[0]!;
    const meta = getMetadata(lastAction);
    const actionType = meta["action_type"] as string | undefined;
    const success = meta["success"] as boolean | undefined;

    if (success === false) {
      nextSteps.push("Resolve the error from the last action");
    } else if (actionType === "file_edit") {
      nextSteps.push("Test the changes made");
    } else if (actionType === "command") {
      const actionData = (meta["action_data"] as Record<string, unknown>) ?? {};
      const command = (actionData["command"] as string) ?? "";
      if (command.includes("test")) {
        if (success) {
          nextSteps.push("Commit the changes");
        } else {
          nextSteps.push("Fix failing tests");
        }
      }
    }
  }

  const now = new Date();
  const startTime = sessionData["start_time"]
    ? new Date(sessionData["start_time"] as string)
    : now;
  const lastActivity = sessionData["last_activity"]
    ? new Date(sessionData["last_activity"] as string)
    : now;

  const state: SessionState = {
    session_id: sessionId,
    start_time: startTime,
    last_activity: lastActivity,
    current_task: (sessionData["current_task"] as string) ?? null,
    open_problems: openProblems,
    next_steps: nextSteps,
    context: (sessionData["context"] as Record<string, unknown>) ?? {},
  };

  return state;
}
