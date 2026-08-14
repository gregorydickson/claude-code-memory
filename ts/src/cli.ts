#!/usr/bin/env bun
/**
 * MemoryGraph CLI - Command-line interface for graph-based memory management.
 *
 * Replaces the MCP server with a direct CLI for storing, searching,
 * and managing memories via FalkorDBLite (local) or Cloud API.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { Config, TOOL_PROFILES, type BackendType } from "./config.js";
import { BackendFactory } from "./backends/factory.js";
import { MemoryDatabase, CloudMemoryDatabase, type IMemoryDatabase } from "./database.js";
import { CloudRESTAdapter } from "./backends/cloud.js";

import { handleStoreMemory, handleGetMemory, handleUpdateMemory, handleDeleteMemory } from "./tools/memory.js";
import { handleSearchMemories, handleRecallMemories, handleContextualSearch } from "./tools/search.js";
import { handleCreateRelationship, handleGetRelatedMemories } from "./tools/relationship.js";
import {
  handleGetMemoryStatistics,
  handleGetRecentActivity,
  handleSearchRelationshipsByContext,
} from "./tools/activity.js";
import {
  handleQueryAsOf,
  handleGetRelationshipHistory,
  handleWhatChanged,
} from "./tools/temporal.js";

import { exportToJson, importFromJson, exportToMarkdown } from "./utils/export-import.js";
import {
  MigrationManager,
  backendConfigFromEnv,
  createMigrationOptions,
  type BackendConfig,
} from "./migration/index.js";

// Intelligence, analytics, proactive, integration
import { extractEntities, linkEntities } from "./intelligence/entity-extraction.js";
import { findSimilarProblems, suggestPatterns } from "./intelligence/pattern-recognition.js";
import { getContext } from "./intelligence/context-retrieval.js";
import {
  getMemoryGraphVisualization,
  analyzeSolutionSimilarity,
  recommendLearningPaths,
  identifyKnowledgeGaps,
} from "./analytics/advanced-queries.js";
import {
  generateSessionBriefing,
  formatBriefingAsText,
} from "./proactive/session-briefing.js";
import { predictNeeds, warnPotentialIssues } from "./proactive/predictive.js";
import { recordOutcome } from "./proactive/outcome-learning.js";
import { captureTaskContext } from "./integration/context-capture.js";
import { detectProject, analyzeCodebase } from "./integration/project-analysis.js";
import { trackWorkflow, suggestWorkflow } from "./integration/workflow-tracking.js";

const VERSION = "0.13.0";

/** Error that signals the CLI should exit with a specific code.Thrown from
 *  inside try blocks so that `finally { await close() }` runs before exit. */
class ExitError extends Error {
  constructor(public code: number) {
    super(`Exit ${code}`);
    this.name = "ExitError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eprint(...args: unknown[]): void {
  console.error(...args);
}

async function createDb(): Promise<{ db: IMemoryDatabase; close: () => Promise<void> }> {
  const backend = await BackendFactory.createBackend();
  const isCloud = backend.backendName() === "cloud";
  const db = isCloud ? new CloudMemoryDatabase(backend) : new MemoryDatabase(backend);

  if (!isCloud) {
    await db.initializeSchema();
  }

  return {
    db,
    close: async () => {
      await db.close();
    },
  };
}

function printConfigSummary(): void {
  const config = Config.getConfigSummary() as Record<string, any>;
  eprint(`\nMemoryGraph CLI v${VERSION}`);
  eprint("\nCurrent Configuration:");
  eprint(`  Backend: ${config.backend}`);
  eprint(`  Tool Profile: ${Config.TOOL_PROFILE}`);
  eprint(`  Log Level: ${config.logging.level}`);

  if (config.backend === "falkordblite" || config.backend === "auto") {
    eprint(`\n  FalkorDBLite Path: ${config.falkordblite.path}`);
  }
  if (config.backend === "sqlite" || config.backend === "auto") {
    eprint(`\n  SQLite Path: ${config.sqlite.path}`);
  }
  if (config.backend === "cloud" || config.backend === "auto") {
    eprint(`\n  Cloud API URL: ${config.cloud.api_url}`);
    eprint(`  Cloud API Key: ${config.cloud.api_key_configured ? "[configured]" : "[not set]"}`);
    eprint(`  Cloud Timeout: ${config.cloud.timeout}s`);
  }
  eprint();
}

async function performHealthCheck(timeout = 5.0): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    status: "unhealthy",
    connected: false,
    backend_type: "unknown",
    timestamp: new Date().toISOString(),
  };

  try {
    const backend = await Promise.race([
      BackendFactory.createBackend(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Health check timed out after ${timeout} seconds`)), timeout * 1000)
      ),
    ]);

    try {
      const healthInfo = await backend.healthCheck();
      Object.assign(result, healthInfo);
      result["status"] = healthInfo.connected ? "healthy" : "unhealthy";
    } finally {
      await backend.disconnect();
    }
  } catch (err) {
    result["error"] = String(err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

const USAGE = `MemoryGraph CLI v${VERSION} - Graph-based memory for AI coding agents

USAGE:
  memorygraph <command> [options]

COMMANDS:
  Memory Operations:
  store       Store a new memory
  get         Get a memory by ID
  update      Update an existing memory
  delete      Delete a memory
  search      Search memories with filters
  recall      Recall memories (fuzzy natural language search)
  related     Get memories related to a specific memory
  link        Create a relationship between two memories

  Context Search:
  context-search   Search relationships by context criteria
  contextual-search  Search within the context of a memory's related items

  Analytics:
  stats       Get database statistics
  activity    Get recent activity summary

  Temporal:
  as-of       Query relationships as of a specific time
  history     Get relationship history for a memory
  changes     Show relationship changes since a time

  Intelligence:
  entities    Extract entities from a memory's content
  patterns    Find similar problems and suggest patterns
  context     Get intelligent context for a query or project

  Analytics (Advanced):
  visualize   Get graph visualization data
  similarity  Analyze solution similarity
  learning    Recommend learning paths
  gaps        Identify knowledge gaps

  Proactive:
  briefing    Generate a session briefing
  predict     Predict what might be needed next
  warn        Warn about potential issues
  outcome     Record an outcome for a memory

  Integration:
  capture     Capture task context from current environment
  analyze-project  Analyze the current project codebase
  workflow    Track or suggest workflow improvements

  Data Management:
  export      Export memories to JSON or Markdown
  import      Import memories from JSON
  migrate     Migrate memories between backends
  health      Run a health check
  config      Show current configuration

GLOBAL OPTIONS:
  --backend <type>    Backend: falkordblite (default), sqlite, falkordb, memgraph, cloud
  --profile <type>    Tool profile: core (default) or extended
  --help, -h          Show this help message
  --version, -v       Show version

EXAMPLES:
  memorygraph store --type solution --title "Fixed timeout" --content "Used retry logic" --tags redis,fix
  memorygraph recall --query "authentication security"
  memorygraph search --query "timeout" --tags redis --limit 10
  memorygraph get <memory-id>
  memorygraph link <from-id> <to-id> SOLVES
  memorygraph stats
  memorygraph export --format json --output backup.json
  memorygraph health
  memorygraph entities <memory-id>
  memorygraph briefing
  memorygraph visualize

ENVIRONMENT VARIABLES:
  MEMORY_BACKEND              Backend type (falkordblite|sqlite|falkordb|memgraph|cloud) [default: falkordblite]
  MEMORY_FALKORDBLITE_PATH    FalkorDBLite database path [default: ~/.memorygraph/falkordblite.db]
  MEMORY_FALKORDB_HOST        FalkorDB server host [default: localhost]
  MEMORY_FALKORDB_PORT        FalkorDB server port [default: 6379]
  MEMORY_MEMGRAPH_URI         Memgraph Bolt URI [default: bolt://localhost:7687]
  MEMORY_SQLITE_PATH          SQLite database path [default: ~/.memorygraph/memory.db]
  MEMORYGRAPH_API_KEY         API key for cloud backend
  MEMORYGRAPH_API_URL         Cloud API URL [default: https://graph-api.memorygraph.dev]
  MEMORY_TOOL_PROFILE         Tool profile (core|extended) [default: core]
  MEMORY_LOG_LEVEL            Log level (DEBUG|INFO|WARNING|ERROR) [default: INFO]
`;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  // Handle global flags
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`memorygraph ${VERSION}`);
    process.exit(0);
  }

  // Extract --backend and --profile global options
  let backendOverride: string | undefined;
  let profileOverride: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backend" && i + 1 < args.length) {
      backendOverride = args[i + 1];
      args.splice(i, 2);
      i--;
    } else if (args[i] === "--profile" && i + 1 < args.length) {
      profileOverride = args[i + 1];
      args.splice(i, 2);
      i--;
    }
  }

  if (backendOverride) {
    process.env["MEMORY_BACKEND"] = backendOverride;
  }
  if (profileOverride) {
    const legacyMap: Record<string, string> = { lite: "core", standard: "extended", full: "extended" };
    process.env["MEMORY_TOOL_PROFILE"] = legacyMap[profileOverride] ?? profileOverride;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case "store":
        await cmdStore(commandArgs);
        break;
      case "get":
        await cmdGet(commandArgs);
        break;
      case "update":
        await cmdUpdate(commandArgs);
        break;
      case "delete":
      case "rm":
        await cmdDelete(commandArgs);
        break;
      case "search":
        await cmdSearch(commandArgs);
        break;
      case "recall":
        await cmdRecall(commandArgs);
        break;
      case "related":
        await cmdRelated(commandArgs);
        break;
      case "link":
        await cmdLink(commandArgs);
        break;
      case "stats":
        await cmdStats(commandArgs);
        break;
      case "activity":
        await cmdActivity(commandArgs);
        break;
      case "as-of":
        await cmdAsOf(commandArgs);
        break;
      case "history":
        await cmdHistory(commandArgs);
        break;
      case "changes":
        await cmdChanges(commandArgs);
        break;
      case "context-search":
        await cmdContextSearch(commandArgs);
        break;
      case "contextual-search":
        await cmdContextualSearch(commandArgs);
        break;
      case "entities":
        await cmdEntities(commandArgs);
        break;
      case "patterns":
        await cmdPatterns(commandArgs);
        break;
      case "context":
        await cmdContext(commandArgs);
        break;
      case "visualize":
        await cmdVisualize(commandArgs);
        break;
      case "similarity":
        await cmdSimilarity(commandArgs);
        break;
      case "learning":
        await cmdLearning(commandArgs);
        break;
      case "gaps":
        await cmdGaps(commandArgs);
        break;
      case "briefing":
        await cmdBriefing(commandArgs);
        break;
      case "predict":
        await cmdPredict(commandArgs);
        break;
      case "warn":
        await cmdWarn(commandArgs);
        break;
      case "outcome":
        await cmdOutcome(commandArgs);
        break;
      case "capture":
        await cmdCapture(commandArgs);
        break;
      case "analyze-project":
        await cmdAnalyzeProject(commandArgs);
        break;
      case "workflow":
        await cmdWorkflow(commandArgs);
        break;
      case "export":
        await cmdExport(commandArgs);
        break;
      case "import":
        await cmdImport(commandArgs);
        break;
      case "migrate":
        await cmdMigrate(commandArgs);
        break;
      case "health":
        await cmdHealth(commandArgs);
        break;
      case "config":
        printConfigSummary();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof ExitError) {
      process.exit(err.code);
    }
    eprint(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function parseSimpleArgs(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const raw = args[i].slice(2);
      if (raw.includes("=")) {
        const eqIdx = raw.indexOf("=");
        result[raw.slice(0, eqIdx)] = raw.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        result[raw] = args[i + 1];
        i++;
      } else {
        result[raw] = true;
      }
    } else {
      if (!result["_positional"]) result["_positional"] = [] as string[];
      (result["_positional"] as string[]).push(args[i]);
    }
  }
  return result;
}

function parseList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Parse a numeric CLI arg, returning undefined if missing or NaN. */
function parseFloatArg(value: unknown): number | undefined {
  if (value === undefined || value === true) return undefined;
  const n = parseFloat(String(value));
  return Number.isNaN(n) ? undefined : n;
}

/** Parse an integer CLI arg, returning undefined if missing or NaN. */
function parseIntArg(value: unknown): number | undefined {
  if (value === undefined || value === true) return undefined;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? undefined : n;
}

async function cmdStore(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);

  if (!parsed["type"] || !parsed["title"] || !parsed["content"]) {
    console.error("Usage: memorygraph store --type <type> --title <title> --content <content> [--tags tag1,tag2] [--importance 0.5] [--summary <summary>]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      type: parsed["type"],
      title: parsed["title"],
      content: parsed["content"],
      summary: parsed["summary"] ?? undefined,
      tags: parseList(parsed["tags"]),
      importance: parseFloatArg(parsed["importance"]) ?? 0.5,
    };

    const result = await handleStoreMemory(db, toolArgs);
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdGet(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) {
    console.error("Usage: memorygraph get <memory-id>");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const result = await handleGetMemory(db, { memory_id: positional[0] });
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdUpdate(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length === 0) {
    console.error("Usage: memorygraph update <memory-id> [--title <title>] [--content <content>] [--tags tag1,tag2] [--importance 0.8]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      memory_id: positional[0],
    };
    if (parsed["title"]) toolArgs["title"] = parsed["title"];
    if (parsed["content"]) toolArgs["content"] = parsed["content"];
    if (parsed["summary"]) toolArgs["summary"] = parsed["summary"];
    if (parsed["tags"]) toolArgs["tags"] = parseList(parsed["tags"]);
    if (parsed["importance"]) toolArgs["importance"] = parseFloatArg(parsed["importance"]);

    const result = await handleUpdateMemory(db, toolArgs);
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdDelete(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) {
    console.error("Usage: memorygraph delete <memory-id>");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const result = await handleDeleteMemory(db, { memory_id: positional[0] });
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdSearch(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      query: parsed["query"] ?? undefined,
      tags: parseList(parsed["tags"]),
      memory_types: parseList(parsed["types"]),
      project_path: parsed["project"] ?? undefined,
      min_importance: parseFloatArg(parsed["min-importance"]),
      limit: Math.min(Math.max(parseIntArg(parsed["limit"]) ?? 50, 1), 1000),
      offset: parseIntArg(parsed["offset"]) ?? 0,
      search_tolerance: parsed["tolerance"] ?? "normal",
      match_mode: parsed["match-mode"] ?? "any",
    };

    const result = await handleSearchMemories(db, toolArgs);
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdRecall(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const query = parsed["query"] ?? (parsed["_positional"] as string[])?.join(" ");

  if (!query || query === true) {
    console.error("Usage: memorygraph recall --query <natural language query> [--limit 20] [--project <path>]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      query,
      memory_types: parseList(parsed["types"]),
      project_path: parsed["project"] ?? undefined,
      limit: parseIntArg(parsed["limit"]) ?? 20,
      offset: parseIntArg(parsed["offset"]) ?? 0,
    };

    const result = await handleRecallMemories(db, toolArgs);
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdRelated(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length === 0) {
    console.error("Usage: memorygraph related <memory-id> [--types SOLVES,CAUSES] [--max-depth 2]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      memory_id: positional[0],
      relationship_types: parseList(parsed["types"]),
      max_depth: parseIntArg(parsed["max-depth"]) ?? 2,
    };

    const result = await handleGetRelatedMemories(db, toolArgs);
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdLink(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length < 3) {
    console.error("Usage: memorygraph link <from-id> <to-id> <RELATIONSHIP_TYPE> [--strength 0.5] [--confidence 0.8] [--context <description>]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      from_memory_id: positional[0],
      to_memory_id: positional[1],
      relationship_type: positional[2],
      strength: parseFloatArg(parsed["strength"]) ?? 0.5,
      confidence: parseFloatArg(parsed["confidence"]) ?? 0.8,
      context: parsed["context"] ?? undefined,
    };

    const result = await handleCreateRelationship(db, toolArgs);
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdStats(_args: string[]): Promise<void> {
  const { db, close } = await createDb();
  try {
    const result = await handleGetMemoryStatistics(db, {});
    console.log(result.text);
  } finally {
    await close();
  }
}

async function cmdActivity(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      days: parseIntArg(parsed["days"]) ?? 7,
      project: parsed["project"] ?? undefined,
    };

    const result = await handleGetRecentActivity(db, toolArgs);
    console.log(result.text);
  } finally {
    await close();
  }
}

async function cmdExport(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const format = parsed["format"] as string;
  const output = parsed["output"] as string;

  if (!format || !output) {
    console.error("Usage: memorygraph export --format <json|markdown> --output <path>");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    if (format === "json") {
      const result = await exportToJson(db, output);
      eprint(`\nExport complete!`);
      eprint(`   Memories: ${result["memory_count"]}`);
      eprint(`   Relationships: ${result["relationship_count"]}`);
      eprint(`   Output: ${output}`);
    } else if (format === "markdown") {
      await exportToMarkdown(db, output);
      eprint(`\nExport complete!`);
      eprint(`   Output: ${output}/`);
    } else {
      console.error(`Invalid format: ${format}. Use 'json' or 'markdown'.`);
      process.exit(1);
    }
  } finally {
    await close();
  }
}

async function cmdImport(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const input = parsed["input"] as string;
  const skipDuplicates = parsed["skip-duplicates"] === true;

  if (!input) {
    console.error("Usage: memorygraph import --input <json-file> [--skip-duplicates]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    // createDb() already calls initializeSchema() for non-cloud backends
    const result = await importFromJson(db, input, skipDuplicates);
    eprint(`\nImport complete!`);
    eprint(`   Imported: ${result["imported_memories"]} memories, ${result["imported_relationships"]} relationships`);
    if (result["skipped_memories"] > 0 || result["skipped_relationships"] > 0) {
      eprint(`   Skipped: ${result["skipped_memories"]} memories, ${result["skipped_relationships"]} relationships`);
    }
  } finally {
    await close();
  }
}

async function cmdHealth(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const jsonOutput = parsed["json"] === true;
  const timeout = parseFloatArg(parsed["timeout"]) ?? 5.0;

  const result = await performHealthCheck(timeout);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    eprint(`MemoryGraph CLI v${VERSION}`);
    eprint("\nHealth Check Results\n");
    eprint(`Status: ${result["status"] === "healthy" ? "Healthy" : "Unhealthy"}`);
    eprint(`Backend: ${result["backend_type"] ?? "unknown"}`);
    eprint(`Connected: ${result["connected"] ? "Yes" : "No"}`);

    if (result["version"]) eprint(`Version: ${result["version"]}`);
    if (result["db_path"]) eprint(`Database: ${result["db_path"]}`);

    if (result["statistics"]) {
      const stats = result["statistics"] as Record<string, unknown>;
      eprint("\nStatistics:");
      if ("memory_count" in stats) eprint(`  Memories: ${stats["memory_count"]}`);
    }

    if (result["error"]) eprint(`\nError: ${result["error"]}`);
    eprint(`\nTimestamp: ${result["timestamp"]}`);
  }

  process.exit(result["status"] === "healthy" ? 0 : 1);
}

async function cmdAsOf(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length < 2) {
    console.error("Usage: memorygraph as-of <memory-id> <iso-timestamp> [--types SOLVES,CAUSES]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const result = await handleQueryAsOf(db, {
      memory_id: positional[0],
      as_of: positional[1],
      relationship_types: parseList(parsed["types"]),
    });
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdHistory(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length < 1) {
    console.error("Usage: memorygraph history <memory-id> [--types SOLVES,CAUSES]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const result = await handleGetRelationshipHistory(db, {
      memory_id: positional[0],
      relationship_types: parseList(parsed["types"]),
    });
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdChanges(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length < 1) {
    console.error("Usage: memorygraph changes <iso-timestamp>");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const result = await handleWhatChanged(db, {
      since: positional[0],
    });
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdMigrate(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const targetBackend = parsed["to"] as string;
  const targetPath = parsed["to-path"] as string | undefined;
  const targetUri = parsed["to-uri"] as string | undefined;
  const dryRun = parsed["dry-run"] === true;
  const noVerify = parsed["no-verify"] === true;

  if (!targetBackend) {
    console.error(
      "Usage: memorygraph migrate --to <backend> [--to-path <path>] [--to-uri <uri>] [--dry-run] [--no-verify]"
    );
    console.error("  Backends: sqlite, falkordblite, cloud, falkordb");
    process.exit(1);
  }

  const sourceConfig = backendConfigFromEnv();
  const targetConfig: BackendConfig = {
    backend_type: targetBackend as any,
    path: targetPath,
    uri: targetUri,
    password: targetBackend !== "cloud" ? undefined : undefined,
    api_key: targetBackend === "cloud" ? Config.MEMORYGRAPH_API_KEY : undefined,
    api_url: targetBackend === "cloud" ? Config.MEMORYGRAPH_API_URL : undefined,
  };

  const options = createMigrationOptions({
    dry_run: dryRun,
    verbose: true,
    verify: !noVerify,
  });

  eprint(`\nMigrating: ${sourceConfig.backend_type} -> ${targetBackend}`);

  const manager = new MigrationManager();
  const result = await manager.migrate(sourceConfig, targetConfig, options);

  if (result.dry_run) {
    eprint("\nDry-run successful - migration would proceed safely");
    if (result.source_stats) {
      eprint(`   Source: ${(result.source_stats as Record<string, unknown>)["memory_count"] ?? 0} memories`);
    }
  } else if (result.success) {
    eprint("\nMigration completed successfully!");
    eprint(`   Migrated: ${result.imported_memories} memories`);
    eprint(`   Migrated: ${result.imported_relationships} relationships`);
    eprint(`   Duration: ${result.duration_seconds.toFixed(1)} seconds`);

    if (result.verification_result) {
      eprint(`\nVerification: ${result.verification_result.sample_passed}/${result.verification_result.sample_checks} samples passed`);
    }
  } else {
    eprint("\nMigration failed!");
    for (const error of result.errors) {
      eprint(`   - ${error}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Context search commands
// ---------------------------------------------------------------------------

async function cmdContextSearch(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length === 0) {
    console.error("Usage: memorygraph context-search <memory-id> [--types SOLVES,CAUSES] [--min-strength 0.5] [--context-query <text>] [--limit 20]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      memory_id: positional[0],
      relationship_types: parseList(parsed["types"]),
      min_strength: parseFloatArg(parsed["min-strength"]),
      context_query: parsed["context-query"] ?? undefined,
      limit: parseIntArg(parsed["limit"]) ?? 20,
    };

    const result = await handleSearchRelationshipsByContext(db, toolArgs);
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

async function cmdContextualSearch(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length === 0 && !parsed["memory-id"]) {
    console.error("Usage: memorygraph contextual-search <memory-id> --query <text> [--max-depth 2]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const toolArgs: Record<string, unknown> = {
      memory_id: positional[0] ?? parsed["memory-id"],
      query: parsed["query"] ?? "",
      max_depth: parseIntArg(parsed["max-depth"]) ?? 2,
    };

    const result = await handleContextualSearch(db, toolArgs);
    console.log(result.text);
    if (result.isError) throw new ExitError(1);
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Intelligence commands
// ---------------------------------------------------------------------------

async function cmdEntities(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length === 0) {
    console.error("Usage: memorygraph entities <memory-id> [--link]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const memory = await db.getMemory(positional[0], false);
    if (!memory) {
      console.error(`Memory not found: ${positional[0]}`);
      throw new ExitError(1);
    }

    const text = `${memory.title ?? ""} ${memory.content ?? ""}`;
    const entities = extractEntities(text);

    if (entities.length === 0) {
      console.log("No entities found in this memory.");
      return;
    }

    console.log(`**Extracted ${entities.length} entities:**\n`);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      console.log(`${i + 1}. **${e.text}** (${e.entity_type})`);
      if (e.confidence) console.log(`   Confidence: ${e.confidence.toFixed(2)}`);
    }

    if (parsed["link"] === true) {
      const backend = (db as MemoryDatabase).backend;
      if (backend) {
        await linkEntities(backend, positional[0], entities);
        console.log("\nEntities linked to memory in graph.");
      }
    }
  } finally {
    await close();
  }
}

async function cmdPatterns(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const query = (parsed["query"] as string) ?? (parsed["_positional"] as string[])?.join(" ");

  if (!query) {
    console.error("Usage: memorygraph patterns --query <problem description>");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const similar = await findSimilarProblems(backend, query);
    const suggestions = await suggestPatterns(backend, query);

    if (similar.length === 0 && suggestions.length === 0) {
      console.log("No similar problems or patterns found.");
      return;
    }

    if (similar.length > 0) {
      console.log(`**Similar Problems (${similar.length}):**\n`);
      for (let i = 0; i < Math.min(similar.length, 10); i++) {
        const s = similar[i] as Record<string, unknown>;
        console.log(`${i + 1}. ${s["title"] ?? s["id"] ?? "Unknown"} (similarity: ${((s["similarity"] ?? 0) as number).toFixed(2)})`);
      }
      console.log();
    }

    if (suggestions.length > 0) {
      console.log(`**Suggested Patterns (${suggestions.length}):**\n`);
      for (let i = 0; i < Math.min(suggestions.length, 10); i++) {
        const s = suggestions[i];
        console.log(`${i + 1}. ${s.name}`);
        if (s.description) console.log(`   ${s.description}`);
      }
    }
  } finally {
    await close();
  }
}

async function cmdContext(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const query = (parsed["query"] as string) ?? (parsed["_positional"] as string[])?.join(" ");
  const project = (parsed["project"] as string) ?? undefined;

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const result = await getContext(backend, typeof query === "string" ? query : "", 4000, project ?? null);

    console.log("**Intelligent Context Retrieval**\n");
    if (result.source_memories && result.source_memories.length > 0) {
      console.log(`**Relevant Memories (${result.source_memories.length}):**\n`);
      for (let i = 0; i < Math.min(result.source_memories.length, 10); i++) {
        const src = result.source_memories[i];
        console.log(`${i + 1}. **${src.title ?? src.id}** (relevance: ${src.relevance.toFixed(2)})`);
      }
    } else {
      console.log("No relevant context found.");
    }

    if (result.query_entities && result.query_entities.length > 0) {
      console.log(`\n**Query Entities:** ${result.query_entities.join(", ")}`);
    }
    if (result.estimated_tokens) {
      console.log(`Estimated tokens: ${result.estimated_tokens}`);
    }
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Advanced analytics commands
// ---------------------------------------------------------------------------

async function cmdVisualize(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const centerId = (parsed["center"] as string) ?? undefined;
  const depth = parseIntArg(parsed["depth"]) ?? 2;
  const maxNodes = parseIntArg(parsed["max-nodes"]) ?? 100;

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const viz = await getMemoryGraphVisualization(backend, centerId ?? null, depth, maxNodes);

    console.log("**Memory Graph Visualization Data**\n");
    console.log(`Nodes: ${viz.nodes?.length ?? 0}`);
    console.log(`Edges: ${viz.edges?.length ?? 0}`);

    if (viz.nodes && viz.nodes.length > 0) {
      console.log("\n**Top Nodes:**\n");
      for (let i = 0; i < Math.min(viz.nodes.length, 20); i++) {
        const n = viz.nodes[i];
        console.log(`${i + 1}. ${n.label ?? n.id} (${n.type ?? "memory"})`);
      }
    }

    if (viz.edges && viz.edges.length > 0) {
      console.log(`\n**Edges (showing ${Math.min(viz.edges.length, 20)} of ${viz.edges.length}):**\n`);
      for (let i = 0; i < Math.min(viz.edges.length, 20); i++) {
        const e = viz.edges[i];
        console.log(`${i + 1}. ${e.from} -> ${e.to} (${e.type ?? "RELATED_TO"})`);
      }
    }

    if (parsed["json"] === true) {
      console.log("\n" + JSON.stringify(viz, null, 2));
    }
  } finally {
    await close();
  }
}

async function cmdSimilarity(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length === 0) {
    console.error("Usage: memorygraph similarity <memory-id> [--top-k 5] [--min-similarity 0.3]");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const topK = parseIntArg(parsed["top-k"]) ?? 5;
    const minSim = parseFloatArg(parsed["min-similarity"]) ?? 0.3;

    const similar = await analyzeSolutionSimilarity(backend, positional[0], topK, minSim);

    if (similar.length === 0) {
      console.log("No similar solutions found.");
      return;
    }

    console.log(`**Similar Solutions (${similar.length}):**\n`);
    for (let i = 0; i < similar.length; i++) {
      const s = similar[i];
      console.log(`${i + 1}. ${s.title} (similarity: ${s.similarity_score.toFixed(2)})`);
      if (s.shared_tags && s.shared_tags.length > 0) console.log(`   Shared tags: ${s.shared_tags.join(", ")}`);
    }
  } finally {
    await close();
  }
}

async function cmdLearning(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const topic = (parsed["topic"] as string) ?? (parsed["_positional"] as string[])?.join(" ") ?? "general";
  const maxPaths = parseIntArg(parsed["max-paths"]) ?? 3;

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const paths = await recommendLearningPaths(backend, topic, maxPaths);

    if (paths.length === 0) {
      console.log("No learning paths could be determined from current memories.");
      return;
    }

    console.log(`**Recommended Learning Paths (${paths.length}):**\n`);
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      console.log(`${i + 1}. ${p.topic}`);
      if (p.steps) {
        for (let j = 0; j < p.steps.length; j++) {
          const step = p.steps[j];
          console.log(`   ${j + 1}. ${step["description"] ?? step["title"] ?? JSON.stringify(step)}`);
        }
      }
      console.log();
    }
  } finally {
    await close();
  }
}

async function cmdGaps(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const project = (parsed["project"] as string) ?? undefined;

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const gaps = await identifyKnowledgeGaps(backend, project ?? null);

    if (gaps.length === 0) {
      console.log("No knowledge gaps identified.");
      return;
    }

    console.log(`**Knowledge Gaps (${gaps.length}):**\n`);
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      console.log(`${i + 1}. ${g.topic}`);
      if (g.description) console.log(`   ${g.description}`);
      if (g.severity) console.log(`   Severity: ${g.severity}`);
      console.log();
    }
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Proactive commands
// ---------------------------------------------------------------------------

async function cmdBriefing(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const projectDir = (parsed["path"] as string) ?? process.cwd();
  const verbosity = (parsed["verbosity"] as "minimal" | "standard" | "detailed") ?? "standard";

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const briefing = await generateSessionBriefing(backend, projectDir);

    if (!briefing) {
      console.log("Could not generate session briefing. No project detected.");
      return;
    }

    const text = formatBriefingAsText(briefing, verbosity);
    console.log(text);
  } finally {
    await close();
  }
}

async function cmdPredict(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const query = (parsed["query"] as string) ?? (parsed["_positional"] as string[])?.join(" ") ?? "";

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const suggestions = await predictNeeds(backend, typeof query === "string" ? query : "");

    if (suggestions.length === 0) {
      console.log("No predictions available.");
      return;
    }

    console.log(`**Predicted Needs (${suggestions.length}):**\n`);
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      console.log(`${i + 1}. ${s.title}`);
      if (s.reason) console.log(`   ${s.reason}`);
      if (s.relevance_score) console.log(`   Relevance: ${s.relevance_score.toFixed(2)}`);
      console.log();
    }
  } finally {
    await close();
  }
}

async function cmdWarn(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const context = (parsed["context"] as string) ?? (parsed["_positional"] as string[])?.join(" ") ?? "";

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const warnings = await warnPotentialIssues(backend, typeof context === "string" ? context : "");

    if (warnings.length === 0) {
      console.log("No potential issues detected.");
      return;
    }

    console.log(`**Potential Issues (${warnings.length}):**\n`);
    for (let i = 0; i < warnings.length; i++) {
      const w = warnings[i];
      console.log(`${i + 1}. ${w.title}`);
      if (w.severity) console.log(`   Severity: ${w.severity}`);
      if (w.description) console.log(`   ${w.description}`);
      if (w.mitigation) console.log(`   Mitigation: ${w.mitigation}`);
      console.log();
    }
  } finally {
    await close();
  }
}

async function cmdOutcome(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const positional = (parsed["_positional"] as string[]) ?? [];

  if (positional.length === 0) {
    console.error("Usage: memorygraph outcome <memory-id> --description <text> --success <true|false>");
    process.exit(1);
  }

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const memoryId = positional[0];
    const description = parsed["description"] as string ?? "Outcome recorded";
    const success = parsed["success"] === "true" || parsed["success"] === true;

    await recordOutcome(backend, memoryId, description, success);
    console.log("Outcome recorded successfully.");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Integration commands
// ---------------------------------------------------------------------------

async function cmdCapture(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const description = (parsed["task"] as string) ?? (parsed["_positional"] as string[])?.join(" ") ?? "";
  const goals = parseList(parsed["goals"]);

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const taskId = await captureTaskContext(backend, description, goals.length > 0 ? goals : ["general"]);

    console.log(`**Task Context Captured** (ID: ${taskId})\n`);
    console.log(`Task: ${description}`);
    if (goals.length > 0) {
      console.log(`Goals: ${goals.join(", ")}`);
    }
  } finally {
    await close();
  }
}

async function cmdAnalyzeProject(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const path = (parsed["path"] as string) ?? process.cwd();

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;
    const project = await detectProject(backend, path);
    const codebase = await analyzeCodebase(backend, path);

    console.log("**Project Analysis**\n");
    if (project) {
      console.log(`Project: ${project.name ?? "Unknown"}`);
      console.log(`Path: ${project.path ?? path}`);
      console.log(`Type: ${project.project_type ?? "Unknown"}`);
    } else {
      console.log("Could not detect project at the specified path.");
    }

    if (codebase) {
      console.log(`\nCodebase:`);
      if (codebase.total_files) console.log(`  Total files: ${codebase.total_files}`);
      if (codebase.file_types) {
        console.log(`  File types: ${Object.entries(codebase.file_types).map(([k, v]) => `${k} (${v})`).join(", ")}`);
      }
    }
  } finally {
    await close();
  }
}

async function cmdWorkflow(args: string[]): Promise<void> {
  const parsed = parseSimpleArgs(args);
  const action = (parsed["action"] as string) ?? "suggest";

  const { db, close } = await createDb();
  try {
    const backend = (db as MemoryDatabase).backend;

    if (action === "track") {
      const actionType = (parsed["type"] as string) ?? "generic";
      const actionData = (parsed["data"] as string) ?? (parsed["_positional"] as string[])?.join(" ") ?? "";
      const sessionId = (parsed["session"] as string) ?? `session_${Date.now()}`;
      await trackWorkflow(backend, sessionId, actionType, { data: actionData });
      console.log("Workflow action tracked.");
    } else {
      const currentContext: Record<string, unknown> = {
        task: (parsed["task"] as string) ?? (parsed["_positional"] as string[])?.join(" ") ?? "",
      };
      const suggestions = await suggestWorkflow(backend, currentContext);
      if (suggestions.length === 0) {
        console.log("No workflow suggestions available.");
        return;
      }
      console.log(`**Workflow Suggestions (${suggestions.length}):**\n`);
      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        console.log(`${i + 1}. ${s.workflow_name}`);
        if (s.description) console.log(`   ${s.description}`);
        if (s.relevance_score) console.log(`   Relevance: ${s.relevance_score.toFixed(2)}`);
        console.log();
      }
    }
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
