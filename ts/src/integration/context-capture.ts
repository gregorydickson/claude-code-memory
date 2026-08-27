/**
 * Development Context Capture for Claude Code Integration.
 *
 * Port of the Python `memorygraph.integration.context_capture` module.
 *
 * Automatically captures development context from Claude Code sessions including:
 * - Task context (description, goals, files involved)
 * - Command executions (commands run, results, errors)
 * - Error pattern analysis (recurring errors, solutions)
 * - Solution effectiveness tracking
 */

import { randomUUID } from "node:crypto";

import type { GraphBackend } from "../backends/index.ts";
import {
  createMemory,
  createRelationshipProperties,
  MemoryType,
  RelationshipType,
  SearchQuerySchema,
  type Memory,
} from "../models.ts";

// ---------------------------------------------------------------------------
// Interfaces (replace Python dataclasses / pydantic models)
// ---------------------------------------------------------------------------

export interface TaskContext {
  task_id: string;
  description: string;
  goals: string[];
  files_involved: string[];
  start_time: Date;
  end_time?: Date | null;
  success?: boolean | null;
  notes?: string | null;
}

export interface CommandExecution {
  command_id: string;
  command: string;
  output: string;
  error?: string | null;
  success: boolean;
  timestamp: Date;
  task_id?: string | null;
}

export interface ErrorPattern {
  pattern_id: string;
  error_type: string;
  error_message: string;
  frequency: number;
  solutions_tried: string[];
  successful_solutions: string[];
  context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Security filters for sensitive data
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|token|password|secret|auth)[=:\s]+['"]?[\w\-.]+['"]?/gi,
  /bearer\s+[\w\-.]+/gi, // Bearer tokens
  /(?:aws|gcp|azure)[_-]?(?:access|secret)[_-]?key[=:\s]+['"]?[\w\-.]+['"]?/gi,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /(?:https?:\/\/)?[\w-]+:[\w-]+@/, // URLs with credentials
  /\b[\w.-]+@[\w.-]+\.(?:com|net|org|io|dev)\b/, // Email addresses (PII)
];

/**
 * Sanitize content by removing sensitive information.
 */
function sanitizeContent(content: string): string {
  let sanitized = content;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Helper: build a Memory with additional_metadata in context
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture task context and store as memory.
 */
export async function captureTaskContext(
  backend: GraphBackend,
  description: string,
  goals: string[],
  files?: string[] | null,
  projectId?: string | null
): Promise<string> {
  // Sanitize inputs
  const cleanDescription = sanitizeContent(description);
  const cleanGoals = goals.map((g) => sanitizeContent(g));
  const cleanFiles = (files ?? []).map((f) => sanitizeContent(f));

  const taskContext: TaskContext = {
    task_id: randomUUID(),
    description: cleanDescription,
    goals: cleanGoals,
    files_involved: cleanFiles,
    start_time: new Date(),
  };

  const metadata: Record<string, unknown> = {
    goals: cleanGoals,
    files: cleanFiles,
    start_time: taskContext.start_time.toISOString(),
  };
  if (projectId) metadata["project_id"] = projectId;

  const memory = buildMemory(
    MemoryType.TASK,
    `Task: ${cleanDescription.slice(0, 100)}`,
    `Description: ${cleanDescription}\n\nGoals:\n` +
      cleanGoals.map((g) => `- ${g}`).join("\n"),
    metadata,
    taskContext.task_id
  );

  const memoryId = await backend.storeMemory(memory);

  // Create relationships to file entities
  // NOTE: FalkorDB v4.16.3 does not implement the Cypher `datetime`
  // function. Pass ISO 8601 timestamps as plain string params so this
  // works on the default falkordblite backend. See M14 / VAL-LOCAL-060.
  //
  // VAL-REVIEW-012: the MERGE key is `text` (matching the intelligence
  // layer's entity namespace in entity-extraction.ts, whose readers match
  // `e.text`) with `name` kept as a display alias, and the relationship is
  // created with the id the MERGE actually RETURNed. The previous code
  // linked with the freshly generated UUID, which only matched a node on
  // first creation — every later capture of the same file silently dropped
  // its INVOLVES edge.
  const nowIso = new Date().toISOString();
  for (const filePath of cleanFiles) {
    const fileId = randomUUID();
    try {
      const result = await backend.executeQuery(
        `
        MERGE (f:Entity {text: $file_path, type: 'file'})
        ON CREATE SET f.id = $file_id, f.created_at = $now
        ON MATCH SET f.last_seen = $now
        SET f.name = $file_path
        RETURN f.id as id
        `,
        { file_path: filePath, file_id: fileId, now: nowIso },
        true
      );
      const entityId = (result[0]?.["id"] as string) ?? fileId;
      await backend.createRelationship(
        memoryId,
        entityId,
        RelationshipType.INVOLVES,
        createRelationshipProperties({ strength: 1.0 })
      );
    } catch (err) {
      console.warn(`Failed to link file entity for ${filePath}:`, err);
    }
  }

  // Link to project if provided
  if (projectId) {
    try {
      await backend.createRelationship(
        memoryId,
        projectId,
        RelationshipType.PART_OF,
        createRelationshipProperties({ strength: 1.0 })
      );
    } catch (err) {
      console.warn(`Failed to link task to project ${projectId}:`, err);
    }
  }

  return memoryId;
}

/**
 * Capture command execution and store as observation memory.
 */
export async function captureCommandExecution(
  backend: GraphBackend,
  command: string,
  output = "",
  error?: string | null,
  success = true,
  taskId?: string | null
): Promise<string> {
  // Sanitize inputs
  const cleanCommand = sanitizeContent(command);
  const cleanOutput = sanitizeContent(output);
  const cleanError = error ? sanitizeContent(error) : null;

  const cmdExec: CommandExecution = {
    command_id: randomUUID(),
    command: cleanCommand,
    output: cleanOutput,
    error: cleanError,
    success,
    timestamp: new Date(),
    task_id: taskId ?? null,
  };

  const metadata: Record<string, unknown> = {
    command: cleanCommand,
    success,
    has_error: Boolean(cleanError),
    timestamp: cmdExec.timestamp.toISOString(),
  };
  if (taskId) metadata["task_id"] = taskId;

  let content = `Command: ${cleanCommand}\n\nSuccess: ${success}\n\nOutput:\n${cleanOutput.slice(0, 500)}`;
  if (cleanError) content += `\n\nError:\n${cleanError.slice(0, 500)}`;

  const memory = buildMemory(
    MemoryType.COMMAND,
    `Command: ${cleanCommand.slice(0, 100)}`,
    content,
    metadata,
    cmdExec.command_id
  );

  const memoryId = await backend.storeMemory(memory);

  // Link to task if provided
  if (taskId) {
    try {
      await backend.createRelationship(
        memoryId,
        taskId,
        RelationshipType.EXECUTED_IN,
        createRelationshipProperties({ strength: 1.0 })
      );
    } catch (err) {
      console.warn(`Failed to link command to task ${taskId}:`, err);
    }
  }

  // Extract and link errors if present
  if (cleanError && !success) {
    const errorPatternIds = await analyzeErrorPatterns(backend, cleanError);
    for (const patternId of errorPatternIds) {
      try {
        await backend.createRelationship(
          memoryId,
          patternId,
          RelationshipType.EXHIBITS,
          createRelationshipProperties({ strength: 0.9 })
        );
      } catch (err) {
        console.warn(`Failed to link command to error pattern ${patternId}:`, err);
      }
    }
  }

  return memoryId;
}

/**
 * Analyze error message and identify patterns.
 */
export async function analyzeErrorPatterns(
  backend: GraphBackend,
  error: string
): Promise<string[]> {
  // Sanitize error
  const cleanError = sanitizeContent(error);

  // Extract error type
  let errorType = "unknown";
  const typeMatch = /^(\w+Error|\w+Exception):/.exec(cleanError);
  if (typeMatch) errorType = typeMatch[1]!;

  // Search for existing error pattern memories
  const patternIds: string[] = [];
  let found = false;

  try {
    const results = await backend.searchMemories(
      SearchQuerySchema.parse({
        memory_types: [MemoryType.ERROR],
        limit: 100,
        include_relationships: false,
      })
    );

    const matching = results.filter(
      (m) => m.context?.additional_metadata?.["error_type"] === errorType
    );

    if (matching.length > 0) {
      found = true;
      for (const pattern of matching) {
        const patternId = pattern.id!;
        // Increment frequency. VAL-REVIEW-016: the previous "increment"
        // only SET m.updated_at — additional_metadata.frequency stayed 1
        // forever. The metadata lives in a JSON-string property that
        // Cypher cannot rewrite, so do the read-modify-write in JS via the
        // backend's getMemory/updateMemory (updateMemory snapshots prior
        // state on Cypher backends).
        try {
          const current = await backend.getMemory(patternId, false);
          if (current?.context) {
            const meta = {
              ...((current.context.additional_metadata as Record<string, unknown>) ?? {}),
            };
            meta["frequency"] = ((meta["frequency"] as number) ?? 1) + 1;
            current.context.additional_metadata = meta;
            await backend.updateMemory(current);
          }
        } catch (err) {
          console.warn(`Failed to update error pattern ${patternId}:`, err);
        }
        patternIds.push(patternId);
      }
    }
  } catch (err) {
    console.warn(`Failed to search for existing error patterns:`, err);
  }

  if (!found) {
    // Create new pattern
    const errorPattern: ErrorPattern = {
      pattern_id: randomUUID(),
      error_type: errorType,
      error_message: cleanError.slice(0, 500),
      frequency: 1,
      solutions_tried: [],
      successful_solutions: [],
      context: {},
    };

    const metadata: Record<string, unknown> = {
      error_type: errorType,
      error_message: errorPattern.error_message,
      frequency: 1,
      solutions_tried: [],
      successful_solutions: [],
    };

    const memory = buildMemory(
      MemoryType.ERROR,
      `Error Pattern: ${errorType}`,
      `Error Type: ${errorType}\n\nMessage Pattern:\n${errorPattern.error_message}`,
      metadata,
      errorPattern.pattern_id
    );

    const patternId = await backend.storeMemory(memory);
    patternIds.push(patternId);
  }

  return patternIds;
}

/**
 * Track effectiveness of a solution for an error pattern.
 */
export async function trackSolutionEffectiveness(
  backend: GraphBackend,
  solutionMemoryId: string,
  errorPatternId: string,
  success: boolean,
  notes?: string | null
): Promise<void> {
  // Create relationship between solution and error pattern
  const relType = success ? RelationshipType.SOLVES : RelationshipType.ATTEMPTED_SOLUTION;

  const props = createRelationshipProperties({
    strength: success ? 1.0 : 0.3,
    confidence: success ? 0.9 : 0.5,
    context: notes ? sanitizeContent(notes) : undefined,
  });

  try {
    await backend.createRelationship(solutionMemoryId, errorPatternId, relType, props);
  } catch (err) {
    console.warn(`Failed to track solution effectiveness:`, err);
  }

  // Update error pattern with solution info.
  // VAL-REVIEW-016: the previous branches only SET updated_at —
  // solutions_tried / successful_solutions were never written. Record the
  // solution id in the pattern's metadata via read-modify-write.
  try {
    const pattern = await backend.getMemory(errorPatternId, false);
    if (pattern?.context) {
      const meta = {
        ...((pattern.context.additional_metadata as Record<string, unknown>) ?? {}),
      };
      const tried = Array.isArray(meta["solutions_tried"])
        ? (meta["solutions_tried"] as string[])
        : [];
      if (!tried.includes(solutionMemoryId)) tried.push(solutionMemoryId);
      meta["solutions_tried"] = tried;
      if (success) {
        const successful = Array.isArray(meta["successful_solutions"])
          ? (meta["successful_solutions"] as string[])
          : [];
        if (!successful.includes(solutionMemoryId)) successful.push(solutionMemoryId);
        meta["successful_solutions"] = successful;
      }
      pattern.context.additional_metadata = meta;
      await backend.updateMemory(pattern);
    }
  } catch (err) {
    console.warn(`Failed to update error pattern solution info:`, err);
  }

  // Update solution effectiveness from its SOLVES/ATTEMPTED_SOLUTION edge
  // stats. VAL-REVIEW-016: the previous query computed the aggregates and
  // then only SET updated_at, discarding them.
  try {
    await backend.executeQuery(
      `
      MATCH (s:Memory {id: $solution_id})
      MATCH (s)-[r:SOLVES|ATTEMPTED_SOLUTION]->(e:Memory {type: 'error'})
      WITH s, COUNT(r) as total_attempts,
           SUM(CASE WHEN type(r) = 'SOLVES' THEN 1 ELSE 0 END) as successes
      SET s.effectiveness = CASE WHEN total_attempts > 0
            THEN toFloat(successes) / total_attempts ELSE s.effectiveness END,
          s.updated_at = $now
      RETURN s.id as id
      `,
      { solution_id: solutionMemoryId, now: new Date().toISOString() },
      true
    );
  } catch (err) {
    console.warn(`Failed to update solution effectiveness stats:`, err);
  }
}
