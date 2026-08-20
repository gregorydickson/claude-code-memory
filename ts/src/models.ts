/**
 * Core data models and schemas for MemoryGraph.
 *
 * Defines the core data structures used throughout the memory system,
 * including memory types, relationships, and validation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MemoryType = {
  TASK: "task",
  CODE_PATTERN: "code_pattern",
  PROBLEM: "problem",
  SOLUTION: "solution",
  PROJECT: "project",
  TECHNOLOGY: "technology",
  ERROR: "error",
  FIX: "fix",
  COMMAND: "command",
  FILE_CONTEXT: "file_context",
  WORKFLOW: "workflow",
  GENERAL: "general",
  CONVERSATION: "conversation",
} as const;

export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

export const ALL_MEMORY_TYPES: string[] = Object.values(MemoryType);

export function isMemoryType(value: string): value is MemoryType {
  return ALL_MEMORY_TYPES.includes(value);
}

export const RelationshipType = {
  // Causal
  CAUSES: "CAUSES",
  TRIGGERS: "TRIGGERS",
  LEADS_TO: "LEADS_TO",
  PREVENTS: "PREVENTS",
  BREAKS: "BREAKS",
  // Solution
  SOLVES: "SOLVES",
  ADDRESSES: "ADDRESSES",
  ALTERNATIVE_TO: "ALTERNATIVE_TO",
  IMPROVES: "IMPROVES",
  REPLACES: "REPLACES",
  // Context
  OCCURS_IN: "OCCURS_IN",
  APPLIES_TO: "APPLIES_TO",
  WORKS_WITH: "WORKS_WITH",
  REQUIRES: "REQUIRES",
  USED_IN: "USED_IN",
  // Learning
  BUILDS_ON: "BUILDS_ON",
  CONTRADICTS: "CONTRADICTS",
  CONFIRMS: "CONFIRMS",
  GENERALIZES: "GENERALIZES",
  SPECIALIZES: "SPECIALIZES",
  // Similarity
  SIMILAR_TO: "SIMILAR_TO",
  VARIANT_OF: "VARIANT_OF",
  RELATED_TO: "RELATED_TO",
  ANALOGY_TO: "ANALOGY_TO",
  OPPOSITE_OF: "OPPOSITE_OF",
  // Workflow
  FOLLOWS: "FOLLOWS",
  DEPENDS_ON: "DEPENDS_ON",
  ENABLES: "ENABLES",
  BLOCKS: "BLOCKS",
  PARALLEL_TO: "PARALLEL_TO",
  // Quality
  EFFECTIVE_FOR: "EFFECTIVE_FOR",
  INEFFECTIVE_FOR: "INEFFECTIVE_FOR",
  PREFERRED_OVER: "PREFERRED_OVER",
  DEPRECATED_BY: "DEPRECATED_BY",
  VALIDATED_BY: "VALIDATED_BY",
} as const;

export type RelationshipType = (typeof RelationshipType)[keyof typeof RelationshipType];

export const ALL_RELATIONSHIP_TYPES: string[] = Object.values(RelationshipType);

export function isRelationshipType(value: string): value is RelationshipType {
  return ALL_RELATIONSHIP_TYPES.includes(value);
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const VALID_VISIBILITY = ["private", "project", "team", "public"] as const;
const VALID_TOLERANCE = ["strict", "normal", "fuzzy"] as const;
const VALID_MATCH_MODE = ["any", "all"] as const;

export const MemoryContextSchema = z.object({
  project_path: z.string().nullish(),
  files_involved: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  technologies: z.array(z.string()).default([]),
  git_commit: z.string().nullish(),
  git_branch: z.string().nullish(),
  working_directory: z.string().nullish(),
  timestamp: z.string().datetime().or(z.date()).default(() => new Date().toISOString()),
  session_id: z.string().nullish(),
  user_id: z.string().nullish(),
  additional_metadata: z.record(z.unknown()).default({}),
  tenant_id: z.string().nullish(),
  team_id: z.string().nullish(),
  visibility: z.enum(VALID_VISIBILITY).default("project"),
  created_by: z.string().nullish(),
});

export type MemoryContext = z.infer<typeof MemoryContextSchema>;

export const MemorySchema = z.object({
  id: z.string().nullish(),
  type: z.enum(ALL_MEMORY_TYPES as [string, ...string[]]),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  summary: z.string().max(500).nullish(),
  tags: z.array(z.string()).transform((tags) =>
    tags.map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0)
  ).default([]),
  context: MemoryContextSchema.nullish(),
  importance: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.8),
  effectiveness: z.number().min(0).max(1).nullish(),
  usage_count: z.number().int().min(0).default(0),
  created_at: z.string().datetime().or(z.date()).default(() => new Date().toISOString()),
  updated_at: z.string().datetime().or(z.date()).default(() => new Date().toISOString()),
  last_accessed: z.string().datetime().or(z.date()).nullish(),
  version: z.number().int().min(1).default(1),
  updated_by: z.string().nullish(),
  // Enriched fields
  relationships: z.record(z.array(z.string())).nullish(),
  match_info: z.record(z.unknown()).nullish(),
  context_summary: z.string().nullish(),
});

export type Memory = z.infer<typeof MemorySchema>;

export const RelationshipPropertiesSchema = z.object({
  strength: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.8),
  context: z.string().nullish(),
  evidence_count: z.number().int().min(0).default(1),
  success_rate: z.number().min(0).max(1).nullish(),
  created_at: z.string().datetime().or(z.date()).default(() => new Date().toISOString()),
  last_validated: z.string().datetime().or(z.date()).default(() => new Date().toISOString()),
  validation_count: z.number().int().min(0).default(0),
  counter_evidence_count: z.number().int().min(0).default(0),
  valid_from: z.string().datetime().or(z.date()).default(() => new Date().toISOString()),
  valid_until: z.string().datetime().or(z.date()).nullish(),
  recorded_at: z.string().datetime().or(z.date()).default(() => new Date().toISOString()),
  invalidated_by: z.string().nullish(),
});

export type RelationshipProperties = z.infer<typeof RelationshipPropertiesSchema>;

export const RelationshipSchema = z.object({
  id: z.string().nullish(),
  from_memory_id: z.string().min(1),
  to_memory_id: z.string().min(1),
  type: z.enum(ALL_RELATIONSHIP_TYPES as [string, ...string[]]),
  properties: RelationshipPropertiesSchema.default({}),
  description: z.string().nullish(),
  bidirectional: z.boolean().default(false),
});

export type Relationship = z.infer<typeof RelationshipSchema>;

export const SearchQuerySchema = z.object({
  query: z.string().nullish(),
  terms: z.array(z.string()).default([]),
  memory_types: z.array(z.string()).default([]),
  tags: z
    .array(z.string())
    .transform((tags) => tags.map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0))
    .default([]),
  project_path: z.string().nullish(),
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  min_importance: z.number().min(0).max(1).nullish(),
  min_confidence: z.number().min(0).max(1).nullish(),
  min_effectiveness: z.number().min(0).max(1).nullish(),
  created_after: z.union([z.string().datetime(), z.date()]).nullish(),
  created_before: z.union([z.string().datetime(), z.date()]).nullish(),
  limit: z.number().int().min(1).max(1000).default(50),
  offset: z.number().int().min(0).default(0),
  include_relationships: z.boolean().default(true),
  search_tolerance: z.enum(VALID_TOLERANCE).default("normal"),
  match_mode: z.enum(VALID_MATCH_MODE).default("any"),
  relationship_filter: z.array(z.string()).nullish(),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const PaginatedResultSchema = z.object({
  results: z.array(MemorySchema),
  total_count: z.number().int(),
  limit: z.number().int().min(1).max(1000),
  offset: z.number().int().min(0),
  has_more: z.boolean(),
  next_offset: z.number().int().nullish(),
});

export type PaginatedResult = z.infer<typeof PaginatedResultSchema>;

export const MemoryGraphSchema = z.object({
  memories: z.array(MemorySchema),
  relationships: z.array(RelationshipSchema),
  metadata: z.record(z.unknown()).default({}),
});

export type MemoryGraph = z.infer<typeof MemoryGraphSchema>;

export const AnalysisResultSchema = z.object({
  analysis_type: z.string(),
  results: z.record(z.unknown()),
  confidence: z.number().min(0).max(1),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.string().datetime().or(z.date()).default(() => new Date().toISOString()),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// ---------------------------------------------------------------------------
// Helper: MemoryNode (graph DB node representation)
// ---------------------------------------------------------------------------

export interface MemoryNode {
  memory: Memory;
  nodeId?: number;
  labels: string[];
}

/**
 * Convert a Memory to a flat property dict suitable for graph DB storage.
 * Datetimes are serialised to ISO strings; nested structures become JSON.
 */
export function memoryToNodeProperties(memory: Memory): Record<string, unknown> {
  const props: Record<string, unknown> = {
    id: memory.id,
    type: memory.type,
    title: memory.title,
    content: memory.content,
    tags: memory.tags,
    importance: memory.importance,
    confidence: memory.confidence,
    usage_count: memory.usage_count,
    created_at: toIso(memory.created_at),
    updated_at: toIso(memory.updated_at),
  };

  if (memory.summary) props.summary = memory.summary;
  if (memory.effectiveness !== null && memory.effectiveness !== undefined)
    props.effectiveness = memory.effectiveness;
  if (memory.last_accessed) props.last_accessed = toIso(memory.last_accessed);

  if (memory.context) {
    for (const [key, value] of Object.entries(memory.context)) {
      if (value === null || value === undefined) continue;
      const propKey = `context_${key}`;
      if (value instanceof Date) {
        props[propKey] = value.toISOString();
      } else if (Array.isArray(value)) {
        if (value.length > 0 && value.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
          props[propKey] = value;
        } else {
          props[propKey] = JSON.stringify(value);
        }
      } else if (typeof value === "object") {
        props[propKey] = JSON.stringify(value);
      } else {
        props[propKey] = value;
      }
    }
  }

  return props;
}

/**
 * Known optional property keys (as stored in the graph) that may be removed
 * when cleared, plus every supported `context_*` field name.
 */
const SCHEMA_OPTIONAL_PROPERTIES = [
  "summary",
  "effectiveness",
  "last_accessed",
  "updated_by",
  "context_summary",
];

/** Every supported context field name (prefixes with `context_`). */
const SCHEMA_CONTEXT_PROPERTIES = Object.keys(MemoryContextSchema.shape).map(
  (key) => `context_${key}`
);

/**
 * The set of graph property names that may appear in a `REMOVE` clause.
 * Restricts derived keys to known schema fields so that runtime context keys
 * (e.g. from `memory.context`) can never inject arbitrary Cypher text.
 */
const CLEARABLE_GRAPH_PROPERTIES = new Set<string>([
  ...SCHEMA_OPTIONAL_PROPERTIES,
  ...SCHEMA_CONTEXT_PROPERTIES,
]);

/**
 * Property keys (as stored in the graph) that must be *removed* before an
 * update, because `memoryToNodeProperties` omits cleared optional fields and
 * `SET m += $properties` would otherwise leave the stale value on the node.
 *
 * Cleared means the field is explicitly null/undefined on the incoming memory
 * (or a context subfield is null). Optional scalar fields (`summary`,
 * `effectiveness`, `last_accessed`, `updated_by`, `context_summary`) and every
 * `context_*` key whose value is nullish are removed. When `memory.context` is
 * entirely null/undefined, all supported context properties are removed.
 *
 * Returned keys are restricted to a schema whitelist and are therefore safe to
 * interpolate into a Cypher `REMOVE` clause.
 */
/** Stored properties cleared by an empty string, matching `memoryToNodeProperties`. */
const EMPTY_STRING_CLEARS = new Set<string>(["summary", "last_accessed"]);

export function clearedMemoryProperties(memory: Memory): string[] {
  const removed: string[] = [];
  for (const prop of SCHEMA_OPTIONAL_PROPERTIES) {
    const value = memory[prop as keyof Memory];
    if (value === null || value === undefined) {
      removed.push(prop);
    } else if (EMPTY_STRING_CLEARS.has(prop) && value === "") {
      removed.push(prop);
    }
  }

  if (!memory.context) {
    // A null/undefined context means every stored context field is cleared.
    removed.push(...SCHEMA_CONTEXT_PROPERTIES);
  } else {
    for (const key of SCHEMA_CONTEXT_PROPERTIES) {
      const contextKey = key.slice("context_".length) as keyof MemoryContext;
      const value = memory.context[contextKey];
      if (value === null || value === undefined) removed.push(key);
    }
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toIso(value: string | Date): string {
  // Normalize every timestamp to a canonical ISO-8601 form (UTC, 3-digit
  // milliseconds). `value` is validated by the Zod `datetime()`/`date()`
  // schemas, so preserving a supplied string verbatim could otherwise store
  // variable fractional precision (e.g. ".0000Z" vs ".000Z") that compares
  // incorrectly when later used in a lexical timestamp comparison.
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return value;
}

export function parseDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

/**
 * Create a new Memory with defaults applied.
 * Context is parsed through the Zod schema so partial contexts are accepted.
 */
export function createMemory(
  input: Omit<Partial<Memory>, "context"> & {
    type: string;
    title: string;
    content: string;
    context?: Record<string, unknown>;
  }
): Memory {
  const now = new Date().toISOString();
  const context = input.context
    ? MemoryContextSchema.parse(input.context)
    : undefined;
  return MemorySchema.parse({
    id: input.id ?? null,
    type: input.type,
    title: input.title,
    content: input.content,
    summary: input.summary ?? null,
    tags: input.tags ?? [],
    context,
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.8,
    effectiveness: input.effectiveness ?? null,
    usage_count: input.usage_count ?? 0,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    last_accessed: input.last_accessed ?? null,
    version: input.version ?? 1,
    updated_by: input.updated_by ?? null,
    relationships: input.relationships ?? undefined,
    match_info: input.match_info ?? undefined,
    context_summary: input.context_summary ?? undefined,
  });
}

/**
 * Create default RelationshipProperties.
 */
export function createRelationshipProperties(
  overrides?: Partial<RelationshipProperties>
): RelationshipProperties {
  const now = new Date().toISOString();
  return {
    strength: 0.5,
    confidence: 0.8,
    context: null,
    evidence_count: 1,
    success_rate: null,
    created_at: now,
    last_validated: now,
    validation_count: 0,
    counter_evidence_count: 0,
    valid_from: now,
    valid_until: null,
    recorded_at: now,
    invalidated_by: null,
    ...overrides,
  };
}

/**
 * Re-export errors for convenience.
 */
export * from "./errors.js";
