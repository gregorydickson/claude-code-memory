# MemoryGraph v0.14.0 — Public Contract

**Enumerated at:** `v0.14.0` (`ts/package.json` version `0.14.0`)
**Semver commitment:** The surfaces enumerated in this document are the public
contract. The project deliberately remains pre-1.0: within the `0.14.x`
patch line these surfaces will not change in a backwards-incompatible way.
Under 0.x conventions a minor bump (`0.15.0+`) may carry breaking changes,
but any such change to an enumerated surface must be called out explicitly
in `CHANGELOG.md`. Additive changes (new commands, new optional flags, new
SDK methods) are permitted in any release. A full stability freeze resumes
at 1.0.0.

This document is the single source of truth for the surface pickle-rick (and
any other external integrator) pins against. It is committed to the repo at
the root so any contract-affecting change is visible in code review.

There are exactly two public surfaces:

1. **CLI command surface** — `memorygraph <command> [options]` (34 commands)
2. **SDK / library surface** — the typed exports of `ts/src/index.ts` and
   `ts/src/sdk/index.ts`

---

## 1. CLI Command Surface (34 commands, enumerated at v0.14.0)

Invocation: `memorygraph <command> [options]` (also: `node src/cli.ts <command>`,
`./memorygraph <command>` for the Bun-compiled binary).

Global options (accepted before the command):

| Flag | Meaning |
|---|---|
| `--backend <type>` | Backend: `falkordblite` (default), `sqlite`, `falkordb`, `memgraph`, `cloud` |
| `--profile <type>` | Tool profile: `core` (default) or `extended` (legacy aliases: `lite`→`core`, `standard`/`full`→`extended`) |
| `--help`, `-h` | Show the usage message |
| `--version`, `-v` | Print the CLI version |

Argument-parsing semantics (frozen, see `parseSimpleArgs` in `ts/src/cli.ts`):

- `--key value` → `key` receives the value `value`
- `--key=value` → `key` receives the value `value`
- `--key=--value` → `key` receives the value `--value` (values starting with
  `--` are accepted when given via `=`)
- `--flag` → `flag` is `true`
- `--` → end-of-options sentinel; args after `--` are positional values even
  if they begin with `--`. If a `--key` is awaiting its value and the next
  arg starts with `--`, that next arg becomes the pending key's value
  (value-escape).
- Bare positional args accumulate into a `_positional` list (per command).

### 1.1 Memory Operations

#### `store`
Store a new memory.
```
memorygraph store --type <type> --title <title> --content <content> \
  [--tags tag1,tag2] [--importance 0.5] [--summary <summary>]
```

#### `get`
Get a memory by ID.
```
memorygraph get <memory-id>
```

#### `update`
Update an existing memory.
```
memorygraph update <memory-id> [--title <title>] [--content <content>] \
  [--tags tag1,tag2] [--importance 0.8] [--summary <summary>]
```

#### `delete` (alias: `rm`)
Delete a memory and its relationships.
```
memorygraph delete <memory-id>
memorygraph rm <memory-id>
```

#### `search`
Search memories with filters.
```
memorygraph search [--query <text>] [--tags tag1,tag2] [--types type1,type2] \
  [--project <path>] [--min-importance 0.5] [--limit 50] [--offset 0] \
  [--tolerance strict|normal|fuzzy] [--match-mode any|all]
```

#### `recall`
Recall memories (fuzzy natural-language search).
```
memorygraph recall --query <natural language query> [--types type1,type2] \
  [--project <path>] [--limit 20] [--offset 0]
```

#### `related`
Get memories related to a specific memory.
```
memorygraph related <memory-id> [--types SOLVES,CAUSES] [--max-depth 2]
```

#### `link`
Create a relationship between two memories.
```
memorygraph link <from-id> <to-id> <RELATIONSHIP_TYPE> \
  [--strength 0.5] [--confidence 0.8] [--context <description>]
```
`<RELATIONSHIP_TYPE>` must be one of the values listed in §3 (RelationshipType
enum). Invalid types are rejected with a clear error.

### 1.2 Context Search

#### `context-search`
Search relationships by context criteria.
```
memorygraph context-search <memory-id> [--types SOLVES,CAUSES] \
  [--min-strength 0.5] [--context-query <text>] [--limit 20]
```

#### `contextual-search`
Search within the context of a memory's related items.
```
memorygraph contextual-search <memory-id> --query <text> [--max-depth 2]
```

### 1.3 Analytics

#### `stats`
Get database statistics.
```
memorygraph stats
```

#### `activity`
Get recent activity summary.
```
memorygraph activity [--days 7] [--project <path>]
```

### 1.4 Temporal

#### `as-of`
Query relationships as of a specific time.
```
memorygraph as-of <memory-id> <iso-timestamp> [--types SOLVES,CAUSES]
```

#### `history`
Get relationship history for a memory.
```
memorygraph history <memory-id> [--types SOLVES,CAUSES]
```

#### `changes`
Show relationship changes since a time.
```
memorygraph changes <iso-timestamp>
```

### 1.5 Intelligence

#### `entities`
Extract entities from a memory's content.
```
memorygraph entities <memory-id> [--link]
```

#### `patterns`
Find similar problems and suggest patterns.
```
memorygraph patterns --query <problem description>
```

#### `context`
Get intelligent context for a query or project.
```
memorygraph context --query <text> [--project <path>]
```

### 1.6 Analytics (Advanced)

#### `visualize`
Get graph visualization data.
```
memorygraph visualize [--center <memory-id>] [--depth 2] [--max-nodes 100] [--json]
```

#### `similarity`
Analyze solution similarity.
```
memorygraph similarity <memory-id> [--top-k 5] [--min-similarity 0.3]
```

#### `learning`
Recommend learning paths.
```
memorygraph learning [--topic <topic>] [--max-paths 3]
```

#### `gaps`
Identify knowledge gaps.
```
memorygraph gaps [--project <path>]
```

### 1.7 Proactive

#### `briefing`
Generate a session briefing.
```
memorygraph briefing [--path <project-dir>] [--verbosity minimal|standard|detailed]
```

#### `predict`
Predict what might be needed next.
```
memorygraph predict [--query <text>]
```

#### `warn`
Warn about potential issues.
```
memorygraph warn [--context <text>]
```

#### `outcome`
Record an outcome for a memory.
```
memorygraph outcome <memory-id> --description <text> --success <true|false>
```

### 1.8 Integration

#### `capture`
Capture task context from current environment.
```
memorygraph capture [--task <description>] [--goals goal1,goal2]
```

#### `analyze-project`
Analyze the current project codebase.
```
memorygraph analyze-project [--path <path>]
```

#### `workflow`
Track or suggest workflow improvements.
```
memorygraph workflow [--action track|suggest] [--type <action-type>] \
  [--data <action-data>] [--session <session-id>] [--task <text>]
```

### 1.9 Data Management

#### `export`
Export memories to JSON or Markdown.
```
memorygraph export --format <json|markdown> --output <path>
```

#### `import`
Import memories from JSON.
```
memorygraph import --input <json-file> [--skip-duplicates]
```
Relationship types in the import file are validated against the
RelationshipType enum; invalid types are skipped with a clear error message
(SEC-11).

#### `migrate`
Migrate memories between backends.
```
memorygraph migrate --to <backend> [--to-path <path>] [--to-uri <uri>] \
  [--dry-run] [--no-verify]
```
`<backend>` ∈ {`sqlite`, `falkordblite`, `cloud`, `falkordb`}.

#### `health`
Run a health check.
```
memorygraph health [--json] [--timeout 5.0]
```

#### `config`
Show current configuration.
```
memorygraph config
```

### 1.10 Environment Variables (frozen)

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_BACKEND` | `falkordblite` | Backend type selection |
| `MEMORY_FALKORDBLITE_PATH` | `~/.memorygraph/falkordblite.db` | FalkorDBLite database path |
| `MEMORY_FALKORDB_HOST` | `localhost` | FalkorDB server host |
| `MEMORY_FALKORDB_PORT` | `6379` | FalkorDB server port |
| `MEMORY_MEMGRAPH_URI` | `bolt://localhost:7687` | Memgraph Bolt URI |
| `MEMORY_SQLITE_PATH` | `~/.memorygraph/memory.db` | SQLite database path |
| `MEMORYGRAPH_API_KEY` | (unset) | API key for cloud backend |
| `MEMORYGRAPH_API_URL` | `https://graph-api.memorygraph.dev` | Cloud API URL |
| `MEMORY_TOOL_PROFILE` | `core` | Tool profile |
| `MEMORY_LOG_LEVEL` | `INFO` | Log level (DEBUG/INFO/WARNING/ERROR) |
| `MEMORYGRAPH_QUERY_TIMEOUT` | `5000` (ms) | Bounded query timeout (M2) |

### 1.11 Exit Codes (frozen)

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Command handled an error and surfaced a generic message (never-throw boundary) |
| Other non-zero | Usage error / command-specific failure |

No CLI command path may exit with an unhandled exception / raw stack trace
(SEC-5 / never-throw boundary, hardened in M2).

---

## 2. SDK / Library Surface (enumerated at v0.14.0)

The library surface is the typed exports of `ts/src/index.ts` (in-process
Node module) and `ts/src/sdk/index.ts` (cloud API client). Importing
`index.ts` is side-effect-free (the CLI is not auto-launched on import — M3).

### 2.1 In-process library — `ts/src/index.ts`

#### Version
```ts
export const VERSION: string;  // "0.14.0"
```

#### Models — re-exported from `ts/src/models.ts`
```ts
export const MemoryType: {
  TASK: "task"; CODE_PATTERN: "code_pattern"; PROBLEM: "problem";
  SOLUTION: "solution"; PROJECT: "project"; TECHNOLOGY: "technology";
  ERROR: "error"; FIX: "fix"; COMMAND: "command"; FILE_CONTEXT: "file_context";
  WORKFLOW: "workflow"; GENERAL: "general"; CONVERSATION: "conversation";
};
export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];
export const ALL_MEMORY_TYPES: string[];
export function isMemoryType(value: string): value is MemoryType;

export const RelationshipType: {
  CAUSES: "CAUSES"; TRIGGERS: "TRIGGERS"; LEADS_TO: "LEADS_TO";
  PREVENTS: "PREVENTS"; BREAKS: "BREAKS";
  SOLVES: "SOLVES"; ADDRESSES: "ADDRESSES"; ALTERNATIVE_TO: "ALTERNATIVE_TO";
  IMPROVES: "IMPROVES"; REPLACES: "REPLACES";
  OCCURS_IN: "OCCURS_IN"; APPLIES_TO: "APPLIES_TO"; WORKS_WITH: "WORKS_WITH";
  REQUIRES: "REQUIRES"; USED_IN: "USED_IN";
  BUILDS_ON: "BUILDS_ON"; CONTRADICTS: "CONTRADICTS"; CONFIRMS: "CONFIRMS";
  GENERALIZES: "GENERALIZES"; SPECIALIZES: "SPECIALIZES";
  SIMILAR_TO: "SIMILAR_TO"; VARIANT_OF: "VARIANT_OF"; RELATED_TO: "RELATED_TO";
  ANALOGY_TO: "ANALOGY_TO"; OPPOSITE_OF: "OPPOSITE_OF";
  FOLLOWS: "FOLLOWS"; DEPENDS_ON: "DEPENDS_ON"; ENABLES: "ENABLES";
  BLOCKS: "BLOCKS"; PARALLEL_TO: "PARALLEL_TO";
  EFFECTIVE_FOR: "EFFECTIVE_FOR"; INEFFECTIVE_FOR: "INEFFECTIVE_FOR";
  PREFERRED_OVER: "PREFERRED_OVER"; DEPRECATED_BY: "DEPRECATED_BY";
  VALIDATED_BY: "VALIDATED_BY";
};
export type RelationshipType = (typeof RelationshipType)[keyof typeof RelationshipType];
export const ALL_RELATIONSHIP_TYPES: string[];
export function isRelationshipType(value: string): value is RelationshipType;

export const MemorySchema: import("zod").ZodObject<...>;
export const MemoryContextSchema: import("zod").ZodObject<...>;
export const RelationshipSchema: import("zod").ZodObject<...>;
export const RelationshipPropertiesSchema: import("zod").ZodObject<...>;
export const SearchQuerySchema: import("zod").ZodObject<...>;
export const PaginatedResultSchema: import("zod").ZodObject<...>;
export const MemoryGraphSchema: import("zod").ZodObject<...>;
export const AnalysisResultSchema: import("zod").ZodObject<...>;

export type Memory = ...;
export type MemoryContext = ...;
export type Relationship = ...;
export type RelationshipProperties = ...;
export type SearchQuery = ...;
export type PaginatedResult = ...;
export type MemoryGraph = ...;
export type AnalysisResult = ...;
export type MemoryNode = { memory: Memory; nodeId?: number; labels: string[] };

export function memoryToNodeProperties(memory: Memory): Record<string, unknown>;
export function createMemory(input: { type: string; title: string; content: string; ... }): Memory;
export function createRelationshipProperties(overrides?: Partial<RelationshipProperties>): RelationshipProperties;
export function parseDate(value: string | Date): Date;
```

#### Errors — re-exported from `ts/src/errors.ts`
```ts
export class MemoryError extends Error { ... }
export class MemoryNotFoundError extends MemoryError { ... }
export class RelationshipError extends MemoryError { ... }
export class ValidationError extends MemoryError { ... }
export class DatabaseConnectionError extends MemoryError { ... }
export class SchemaError extends MemoryError { ... }
export class NotFoundError extends MemoryError { ... }
export class BackendError extends MemoryError { ... }
export class ConfigurationError extends MemoryError { ... }
// (TimeoutError is exported from errors.ts and used internally; it is part
//  of the fail-open contract: a backend query exceeding
//  MEMORYGRAPH_QUERY_TIMEOUT raises TimeoutError at the executeQuery choke
//  point, which the never-throw boundary surfaces generically.)
```

#### Config — re-exported from `ts/src/config.ts`
```ts
export const Config: {
  static getConfigSummary(): Record<string, any>;
  static readonly TOOL_PROFILE: string;
  static readonly MEMORYGRAPH_API_KEY: string | undefined;
  static readonly MEMORYGRAPH_API_URL: string;
  static readonly QUERY_TIMEOUT: number;  // ms (M2)
  // ...static getters for each env-backed config value
};
export const TOOL_PROFILES: Record<string, ...>;
export type BackendType = "falkordblite" | "sqlite" | "falkordb" | "memgraph" | "cloud" | "neo4j" | "turso" | "ladybugdb" | "auto";
export const ALL_BACKEND_TYPES: string[];
```

#### Backends — re-exported from `ts/src/backends/index.ts`
```ts
export interface GraphBackend {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  initializeSchema(): Promise<void>;
  storeMemory(memory: Memory): Promise<string>;
  getMemory(memoryId: string, includeRelationships?: boolean): Promise<Memory | null>;
  searchMemories(searchQuery: SearchQuery): Promise<Memory[]>;
  updateMemory(memory: Memory): Promise<boolean>;
  deleteMemory(memoryId: string): Promise<boolean>;
  createRelationship(
    fromMemoryId: string,
    toMemoryId: string,
    relationshipType: string,
    properties?: RelationshipProperties
  ): Promise<string>;
  getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[Memory, Relationship][]>;
  getMemoryStatistics(): Promise<Record<string, unknown>>;
  getRecentActivity?(days?: number, project?: string | null): Promise<Record<string, unknown>>;
  executeQuery(query: string, parameters?: Record<string, unknown>, write?: boolean): Promise<Record<string, unknown>[]>;
  healthCheck(): Promise<HealthCheckResult>;
  backendName(): string;
  supportsFulltextSearch(): boolean;
  supportsTransactions(): boolean;
  isCypherCapable(): boolean;
}
export type HealthCheckResult = Record<string, unknown>;
export class BaseFalkorDBBackend implements GraphBackend { ... }
export class FalkorDBLiteBackend extends BaseFalkorDBBackend { ... }
export class FalkorDBBackend extends BaseFalkorDBBackend { ... }
export class BaseBoltBackend implements GraphBackend { ... }
export class MemgraphBackend extends BaseBoltBackend { ... }
export class CloudRESTAdapter { ... }
export class CloudBackend implements GraphBackend { ... }
export class CircuitBreaker { ... }
export class SQLiteBackend implements GraphBackend { ... }

export { BackendFactory } from "./backends/factory.ts";
```

#### Database — re-exported from `ts/src/database.ts`
```ts
export interface IMemoryDatabase {
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
  storeMemory(memory: Memory): Promise<string>;
  getMemory(memoryId: string, includeRelationships?: boolean): Promise<Memory | null>;
  searchMemories(searchQuery: SearchQuery): Promise<Memory[]>;
  searchMemoriesPaginated?(searchQuery: SearchQuery): Promise<PaginatedResult>;
  updateMemory(memory: Memory): Promise<boolean>;
  deleteMemory(memoryId: string): Promise<boolean>;
  createRelationship(
    fromMemoryId: string,
    toMemoryId: string,
    relationshipType: string,
    properties?: RelationshipProperties
  ): Promise<string>;
  getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[Memory, Relationship][]>;
  getMemoryStatistics(): Promise<Record<string, unknown>>;
  getRecentActivity?(days?: number, project?: string | null): Promise<Record<string, unknown>>;
}
export class MemoryDatabase implements IMemoryDatabase {
  backend: GraphBackend;
  constructor(backend: GraphBackend);
  // ...all IMemoryDatabase methods
}
export class CloudMemoryDatabase implements IMemoryDatabase {
  backend: GraphBackend;
  constructor(backend: GraphBackend);
  // ...all IMemoryDatabase methods
}
```

#### Tools — re-exported from `ts/src/tools/index.ts`
```ts
export function handleStoreMemory(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleGetMemory(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleUpdateMemory(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleDeleteMemory(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleSearchMemories(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleRecallMemories(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleContextualSearch(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleCreateRelationship(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleGetRelatedMemories(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleGetMemoryStatistics(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleGetRecentActivity(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleQueryAsOf(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleGetRelationshipHistory(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
export function handleWhatChanged(db: IMemoryDatabase, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
```
All `handleX` exports are wrapped by the never-throw tool boundary
(`handleToolErrors` + `neverThrowBoundary`): they return a structured
`{ isError, text }` result and never throw across the integration boundary
(M2 / SEC-5).

#### Utils — re-exported from `ts/src/utils/index.ts`
```ts
export function utcNow(): string;
export function parseDatetime(value: string | Date): Date;
export function ensureAware(value: string | Date): Date;
export function parseMemoryFromProperties(props: Record<string, unknown>): Memory;
export function validateMemoryInput(input: Record<string, unknown>): Memory;
export function validateSearchInput(input: Record<string, unknown>): SearchQuery;
export function validateRelationshipInput(input: Record<string, unknown>): { from_memory_id: string; to_memory_id: string; relationship_type: string; properties?: RelationshipProperties };
export function detectProjectContext(...): ...;
export function extractContextStructure(...): ...;
export function parseContext(...): ...;
export function hasCycle(graph: Map<string, string[]>): boolean;
export function exportToJson(db: IMemoryDatabase, outputPath: string): Promise<Record<string, unknown>>;
export function importFromJson(db: IMemoryDatabase, inputPath: string, skipDuplicates?: boolean): Promise<Record<string, number>>;
export function exportToMarkdown(db: IMemoryDatabase, outputDir: string): Promise<void>;
```
`importFromJson` validates every relationship type against the
`RelationshipType` enum and skips invalid types with a clear error message
(SEC-11 / VAL-FREEZE-008).

#### Migration — re-exported from `ts/src/migration/index.ts`
```ts
export type BackendConfig = { backend_type: string; path?: string; uri?: string; password?: string; api_key?: string; api_url?: string; };
export type MigrationOptions = { dry_run: boolean; verbose: boolean; verify: boolean; };
export type MigrationResult = { success: boolean; ... };
export class MigrationManager { migrate(source: BackendConfig, target: BackendConfig, options: MigrationOptions): Promise<MigrationResult>; }
export class MigrationError extends Error { ... }
export function backendConfigFromEnv(): BackendConfig;
export function createMigrationOptions(overrides?: Partial<MigrationOptions>): MigrationOptions;
```

#### Namespaced re-exports
```ts
export * as intelligence from "./intelligence/index.ts";  // entity extraction, pattern recognition, context retrieval
export * as analytics    from "./analytics/index.ts";      // graph visualization, similarity, learning paths, knowledge gaps
export * as proactive    from "./proactive/index.ts";      // session briefing, predictions, outcome learning
export * as integration   from "./integration/index.ts";   // context capture, project analysis, workflow tracking
export * as sdk           from "./sdk/index.ts";            // cloud API client (see §2.2)
```

### 2.2 Cloud SDK — `ts/src/sdk/index.ts`

```ts
export const SDK_VERSION: string;  // "0.1.0" — versioned independently of the CLI/library VERSION

export class MemoryGraphClient {
  constructor(options: MemoryGraphClientOptions);
  // Memory operations
  createMemory(params: CreateMemoryParams): Promise<Memory>;
  getMemory(memoryId: string, includeRelationships?: boolean): Promise<Memory>;
  updateMemory(memoryId: string, params: UpdateMemoryParams): Promise<Memory>;
  deleteMemory(memoryId: string): Promise<boolean>;
  searchMemories(params?: SearchMemoriesParams): Promise<Memory[]>;
  recallMemories(params: RecallMemoriesParams): Promise<Memory[]>;
  // Relationship operations
  createRelationship(params: CreateRelationshipParams): Promise<Relationship>;
  getRelatedMemories(memoryId: string, params?: GetRelatedMemoriesParams): Promise<RelatedMemory[]>;
  // Lifecycle
  close(): void;
  get closed(): boolean;
}

export interface MemoryGraphClientOptions {
  apiKey?: string;   // falls back to MEMORYGRAPH_API_KEY env var
  apiUrl?: string;   // default: https://api.memorygraph.dev
  timeout?: number;  // default: 30000 (ms)
}
export interface CreateMemoryParams { type: string; title: string; content: string; tags?: string[]; importance?: number; context?: Record<string, unknown>; summary?: string; }
export interface UpdateMemoryParams { title?: string; content?: string; tags?: string[]; importance?: number; summary?: string; }
export interface SearchMemoriesParams { query?: string; memory_types?: string[]; tags?: string[]; min_importance?: number; limit?: number; offset?: number; }
export interface RecallMemoriesParams { query: string; memory_types?: string[]; project_path?: string; limit?: number; }
export interface CreateRelationshipParams { from_memory_id: string; to_memory_id: string; relationship_type: string; strength?: number; confidence?: number; context?: string; }
export interface GetRelatedMemoriesParams { relationship_types?: string[]; max_depth?: number; }

// Models (SDK-local re-exports)
export { MemoryType, RelationshipType } from "./models.ts";
export type { Memory, MemoryCreate, MemoryUpdate, Relationship, RelationshipCreate, SearchResult, RelatedMemory } from "./models.ts";

// Exceptions
export class MemoryGraphError extends Error { ... }
export class AuthenticationError extends MemoryGraphError { ... }
export class RateLimitError extends MemoryGraphError { ... }
export class NotFoundError extends MemoryGraphError { ... }
export class ValidationError extends MemoryGraphError { ... }
export class ServerError extends MemoryGraphError { ... }
```

The Cloud SDK is **Tier 2** and is out of scope for the v0.14.0 local-mode
integration contract; its method signatures are nonetheless pinned here so
external cloud consumers can rely on them. Behavioral changes to cloud
egress/redaction/TLS/retention are governed by the Tier 2 roadmap, not this
contract.

---

## 3. RelationshipType Enum (enumerated at v0.14.0)

The full set of valid relationship types (used by `link`, `import`, and
validated by `createRelationship` on every backend — SEC-11):

```
CAUSES, TRIGGERS, LEADS_TO, PREVENTS, BREAKS,
SOLVES, ADDRESSES, ALTERNATIVE_TO, IMPROVES, REPLACES,
OCCURS_IN, APPLIES_TO, WORKS_WITH, REQUIRES, USED_IN,
BUILDS_ON, CONTRADICTS, CONFIRMS, GENERALIZES, SPECIALIZES,
SIMILAR_TO, VARIANT_OF, RELATED_TO, ANALOGY_TO, OPPOSITE_OF,
FOLLOWS, DEPENDS_ON, ENABLES, BLOCKS, PARALLEL_TO,
EFFECTIVE_FOR, INEFFECTIVE_FOR, PREFERRED_OVER, DEPRECATED_BY, VALIDATED_BY,
INVOLVES, PART_OF, EXECUTED_IN, EXHIBITS, ATTEMPTED_SOLUTION,
IN_SESSION, MODIFIES, CREATES, FOUND_IN
```

The final `INVOLVES, PART_OF, EXECUTED_IN, EXHIBITS, ATTEMPTED_SOLUTION,
IN_SESSION, MODIFIES, CREATES, FOUND_IN` row was added in M7 (L4,
VAL-P2-004) so the integration modules (context-capture / workflow-tracking
/ project-analysis) emit only `RelationshipType` enum values. Per §4 this is
an additive enum extension (backwards-compatible).

The `MemoryType` enum (valid `--type` values for `store`) is likewise frozen:
```
task, code_pattern, problem, solution, project, technology, error, fix,
command, file_context, workflow, general, conversation
```

---

## 4. Semver Policy

This contract is governed by [Semantic Versioning 2.0.0](https://semver.org/).

**Backwards-compatible** (allowed in minor/patch releases):
- Adding a new CLI command
- Adding a new optional flag to an existing command
- Adding a new SDK method or interface field
- Adding a new value to an enum (MemoryType / RelationshipType) — note this
  is technically a breaking change for consumers that use exhaustive
  `switch`/`if`-chains over enum values; MemoryGraph treats enum additions
  as additive because all validation paths use `isXType()` membership
  checks, not exhaustiveness checks.

**Breaking** (require a major-version bump, v2.0.0+):
- Removing or renaming an existing CLI command
- Changing the semantics of an existing command's flag
- Removing or renaming an exported SDK symbol
- Changing the signature of an exported SDK method (parameter types, return
  type, arity)
- Changing the structured output format of a CLI command in a way that
  breaks parsers
- Changing the exit-code semantics of a CLI command

**Bug fixes** that change observable behavior are evaluated case-by-case: if
the previous behavior was a documented bug (e.g. SEC-11's silent acceptance
of invalid relationship types), the fix is a patch; otherwise it is a
breaking change.

---

## 5. Cross-References

- `ts/package.json` — the `version` field is `1.0.0` and is the canonical
  version source.
- `ts/src/cli.ts` — the CLI dispatch (34 `case` entries) and `parseSimpleArgs`
  implement §1.
- `ts/src/index.ts` — the library barrel exports implement §2.1.
- `ts/src/sdk/index.ts` — the cloud API client exports implement §2.2.
- `ts/src/models.ts` — the `MemoryType` and `RelationshipType` enums
  implement §3.
- `docs/planning/D1-DECISION.md` — the local backend story (Option C) that
  scopes which features are full-fidelity on which backend.
- `master-plan.md` — the integration-readiness gates that this freeze
  satisfies (Tier 0 #3).
