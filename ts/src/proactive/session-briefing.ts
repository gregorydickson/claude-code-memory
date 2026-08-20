/**
 * Session Start Intelligence for MemoryGraph.
 *
 * Port of the Python `memorygraph.proactive.session_briefing` module.
 * Provides automatic briefing when a session starts, including:
 * - Recent project activity
 * - Unresolved problems
 * - Relevant patterns
 * - Deprecation warnings
 * - Recommended next steps
 */

import type { GraphBackend } from "../backends/index.js";
import { parseDatetime } from "../utils/datetime.js";
import { detectProject, type ProjectInfo } from "../integration/project-analysis.js";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Recent activity in a project. */
export interface RecentActivity {
  memory_id: string;
  memory_type: string;
  title: string;
  summary?: string | null;
  timestamp: Date;
  tags: string[];
}

/** Unresolved problem without a solution. */
export interface UnresolvedProblem {
  problem_id: string;
  title: string;
  description: string;
  created_at: Date;
  tags: string[];
  related_memories: number;
}

/** Relevant pattern for current project. */
export interface RelevantPattern {
  pattern_id: string;
  pattern_type: string;
  description: string;
  effectiveness: number;
  usage_count: number;
  last_used?: Date | null;
}

/** Warning about deprecated approaches. */
export interface DeprecationWarningItem {
  deprecated_id: string;
  deprecated_title: string;
  reason: string;
  replacement_id?: string | null;
  replacement_title?: string | null;
}

/** Complete session briefing for a project. */
export interface SessionBriefing {
  project_name: string;
  project_path: string;
  project_type: string;
  briefing_timestamp: Date;
  recent_activities: RecentActivity[];
  total_memories: number;
  unresolved_problems: UnresolvedProblem[];
  relevant_patterns: RelevantPattern[];
  deprecation_warnings: DeprecationWarningItem[];
  has_active_issues: boolean;
  has_warnings: boolean;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format briefing as human-readable text.
 *
 * @param briefing - Session briefing to format
 * @param verbosity - "minimal", "standard", or "detailed"
 * @returns Formatted briefing text
 */
export function formatBriefingAsText(
  briefing: SessionBriefing,
  verbosity: "minimal" | "standard" | "detailed" = "standard"
): string {
  const lines: string[] = [];
  lines.push(`# Session Briefing for ${briefing.project_name}`);
  lines.push(`Path: ${briefing.project_path}`);
  lines.push(`Type: ${briefing.project_type}`);
  lines.push(`Time: ${briefing.briefing_timestamp.toISOString().slice(0, 16).replace("T", " ")}`);
  lines.push("");

  // Recent Activity
  if (briefing.recent_activities.length > 0) {
    lines.push("## Recent Activity");
    const count =
      verbosity === "minimal" ? 5 : verbosity === "standard" ? 10 : briefing.recent_activities.length;
    for (const activity of briefing.recent_activities.slice(0, count)) {
      const ageDays = Math.floor(
        (Date.now() - activity.timestamp.getTime()) / (1000 * 60 * 60 * 24)
      );
      const ageStr = ageDays > 0 ? `${ageDays}d ago` : "today";
      lines.push(`- [${activity.memory_type}] ${activity.title} (${ageStr})`);
      if (verbosity === "detailed" && activity.summary) {
        lines.push(`  ${activity.summary}`);
      }
    }
    lines.push("");
  }

  // Active Issues
  if (briefing.unresolved_problems.length > 0) {
    lines.push("## Active Issues");
    for (const problem of briefing.unresolved_problems) {
      const ageDays = Math.floor(
        (Date.now() - problem.created_at.getTime()) / (1000 * 60 * 60 * 24)
      );
      lines.push(`- ${problem.title} (${ageDays}d old)`);
      if (verbosity === "standard" || verbosity === "detailed") {
        lines.push(`  ${problem.description.slice(0, 200)}...`);
      }
    }
    lines.push("");
  }

  // Recommended Patterns
  if (briefing.relevant_patterns.length > 0) {
    lines.push("## Recommended Patterns");
    const count = verbosity === "minimal" ? 3 : 5;
    for (const pattern of briefing.relevant_patterns.slice(0, count)) {
      const effPct = Math.floor(pattern.effectiveness * 100);
      lines.push(`- ${pattern.pattern_type}: ${pattern.description}`);
      if (verbosity === "standard" || verbosity === "detailed") {
        lines.push(`  Effectiveness: ${effPct}%, Used ${pattern.usage_count} times`);
      }
    }
    lines.push("");
  }

  // Warnings
  if (briefing.deprecation_warnings.length > 0) {
    lines.push("## Deprecation Warnings");
    for (const warning of briefing.deprecation_warnings) {
      lines.push(`- ${warning.deprecated_title} is deprecated`);
      if (warning.replacement_title) {
        lines.push(`  Use instead: ${warning.replacement_title}`);
      }
      if (verbosity === "detailed") {
        lines.push(`  Reason: ${warning.reason}`);
      }
    }
    lines.push("");
  }

  // Summary
  lines.push("## Summary");
  lines.push(`- Total memories: ${briefing.total_memories}`);
  lines.push(`- Active issues: ${briefing.unresolved_problems.length}`);
  lines.push(`- Patterns available: ${briefing.relevant_patterns.length}`);
  if (briefing.deprecation_warnings.length > 0) {
    lines.push(`- ${briefing.deprecation_warnings.length} deprecation warnings`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Generate session briefing
// ---------------------------------------------------------------------------

/**
 * Generate a session briefing for a project.
 *
 * @param backend - Database backend
 * @param projectDir - Project directory path
 * @param recencyDays - How many days back to look for recent activity
 * @param maxActivities - Maximum number of recent activities to include
 * @returns SessionBriefing if project detected, null otherwise
 */
export async function generateSessionBriefing(
  backend: GraphBackend,
  projectDir: string,
  recencyDays = 7,
  maxActivities = 10
): Promise<SessionBriefing | null> {
  const project = await detectProject(backend, projectDir);
  if (!project) {
    console.warn(`Could not detect project at ${projectDir}`);
    return null;
  }

  console.info(`Generating session briefing for project: ${project.name}`);

  // A memory belongs to a project when it carries the project path, or when
  // it is unassigned (context_project_path is null). Unassigned memories are
  // included so a briefing still reflects data that was captured without an
  // explicit project association.
  //
  // The active match is path-boundary-aware: it matches an exact path or a
  // path that equals a parent/first segment (i.e. the node path begins with
  // `$project_path/`), unlike an unbounded substring CONTAINS which would
  // let project `app` also match `/work/application` or `/other/app`.
  const projectFilter = (node: string): string =>
    `(${node}.context_project_path IS NULL OR ${node}.context_project_path = $project_path OR ${node}.context_project_path STARTS WITH $project_prefix)`;

  // `$project_path/` — the directory boundary prefix for the STARTS WITH
  // clause, so only direct children of the project path match (not unrelated
  // paths sharing a common substring).
  const projectPrefix = `${project.path}/`;

  const briefing: SessionBriefing = {
    project_name: project.name,
    project_path: project.path,
    project_type: project.project_type,
    briefing_timestamp: new Date(),
    recent_activities: [],
    total_memories: 0,
    unresolved_problems: [],
    relevant_patterns: [],
    deprecation_warnings: [],
    has_active_issues: false,
    has_warnings: false,
  };

  // Total memory count
  const totalCountQuery = `
    MATCH (m:Memory)
    WHERE ${projectFilter("m")}
    RETURN count(m) as total
  `;

  try {
    const result = await backend.executeQuery(totalCountQuery, {
      project_path: project.path,
      project_prefix: projectPrefix,
    });
    briefing.total_memories =
      result && result.length > 0 ? ((result[0]["total"] as number) ?? 0) : 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error counting memories: ${message}`);
  }

  // Recent activities
  const cutoffDate = new Date(Date.now() - recencyDays * 24 * 60 * 60 * 1000);

  const recentQuery = `
    MATCH (m:Memory)
    WHERE ${projectFilter("m")}
      AND m.created_at >= $cutoff
    RETURN m.id as id, m.type as type, m.title as title,
           m.summary as summary, m.created_at as created_at,
           m.tags as tags
    ORDER BY m.created_at DESC
    LIMIT $limit
  `;

  try {
    const results = await backend.executeQuery(recentQuery, {
      project_path: project.path,
      project_prefix: projectPrefix,
      cutoff: cutoffDate.toISOString(),
      limit: maxActivities,
    });

    for (const record of results ?? []) {
      briefing.recent_activities.push({
        memory_id: record["id"] as string,
        memory_type: (record["type"] as string) ?? "",
        title: (record["title"] as string) ?? "",
        summary: (record["summary"] as string | undefined) ?? null,
        timestamp: parseDatetime(record["created_at"] as string),
        tags: (record["tags"] as string[]) ?? [],
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error fetching recent activities: ${message}`);
  }

  // Unresolved problems
  const problemsQuery = `
    MATCH (p:Memory {type: 'problem'})
    WHERE ${projectFilter("p")}
      AND NOT (p)<-[:SOLVES|ADDRESSES]-(:Memory)
    OPTIONAL MATCH (p)-[r]-()
    RETURN p.id as id, p.title as title, p.content as content,
           p.created_at as created_at, p.tags as tags,
           count(r) as related_count
    ORDER BY p.created_at DESC
    LIMIT 5
  `;

  try {
    const results = await backend.executeQuery(problemsQuery, {
      project_path: project.path,
      project_prefix: projectPrefix,
    });

    for (const record of results ?? []) {
      const content = (record["content"] as string) ?? "";
      briefing.unresolved_problems.push({
        problem_id: record["id"] as string,
        title: (record["title"] as string) ?? "",
        description: content.slice(0, 200),
        created_at: parseDatetime(record["created_at"] as string),
        tags: (record["tags"] as string[]) ?? [],
        related_memories: (record["related_count"] as number) ?? 0,
      });
    }

    briefing.has_active_issues = briefing.unresolved_problems.length > 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error fetching unresolved problems: ${message}`);
  }

  // Relevant patterns
  const patternsQuery = `
    MATCH (m:Memory {type: 'code_pattern'})
    WHERE ${projectFilter("m")}
    RETURN m.id as id, m.title as type, m.content as description,
           m.effectiveness as effectiveness, m.usage_count as usage_count,
           m.last_accessed as last_used
    ORDER BY m.effectiveness DESC, m.usage_count DESC
    LIMIT 5
  `;

  try {
    const results = await backend.executeQuery(patternsQuery, {
      project_path: project.path,
      project_prefix: projectPrefix,
    });

    for (const record of results ?? []) {
      const description = (record["description"] as string) ?? "";
      const lastUsedRaw = record["last_used"];
      let lastUsed: Date | null = null;
      if (lastUsedRaw) {
        try {
          lastUsed = parseDatetime(lastUsedRaw as string);
        } catch {
          lastUsed = null;
        }
      }

      briefing.relevant_patterns.push({
        pattern_id: record["id"] as string,
        pattern_type: (record["type"] as string) ?? "",
        description: description.slice(0, 200),
        effectiveness: (record["effectiveness"] as number) ?? 0.5,
        usage_count: (record["usage_count"] as number) ?? 0,
        last_used: lastUsed,
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error fetching patterns: ${message}`);
  }

  // Deprecation warnings
  const deprecatedQuery = `
    MATCH (old:Memory)-[r:DEPRECATED_BY]->(new:Memory)
    WHERE ${projectFilter("old")}
    RETURN old.id as old_id, old.title as old_title,
           new.id as new_id, new.title as new_title,
           r.context as reason
    LIMIT 5
  `;

  try {
    const results = await backend.executeQuery(deprecatedQuery, {
      project_path: project.path,
      project_prefix: projectPrefix,
    });

    for (const record of results ?? []) {
      briefing.deprecation_warnings.push({
        deprecated_id: record["old_id"] as string,
        deprecated_title: (record["old_title"] as string) ?? "",
        reason: ((record["reason"] as string) ?? "No longer recommended"),
        replacement_id: (record["new_id"] as string | undefined) ?? null,
        replacement_title: (record["new_title"] as string | undefined) ?? null,
      });
    }

    briefing.has_warnings = briefing.deprecation_warnings.length > 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error fetching deprecation warnings: ${message}`);
  }

  console.info(
    `Session briefing generated: ${briefing.recent_activities.length} activities, ` +
      `${briefing.unresolved_problems.length} problems, ` +
      `${briefing.relevant_patterns.length} patterns`
  );

  return briefing;
}

// ---------------------------------------------------------------------------
// MCP resource formatting
// ---------------------------------------------------------------------------

/**
 * Format session briefing as an MCP resource.
 *
 * @param briefing - Session briefing to format
 * @param verbosity - Verbosity level ("minimal", "standard", "detailed")
 * @returns MCP resource dictionary
 */
export function getSessionBriefingResource(
  briefing: SessionBriefing,
  verbosity: "minimal" | "standard" | "detailed" = "standard"
): Record<string, unknown> {
  return {
    uri: `memory://session/briefing/${briefing.project_name}`,
    name: `Session Briefing: ${briefing.project_name}`,
    description: `Automatic session briefing for ${briefing.project_name}`,
    mimeType: "text/markdown",
    text: formatBriefingAsText(briefing, verbosity),
  };
}
