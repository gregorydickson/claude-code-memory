# Changelog

All notable changes to MemoryGraph will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned (v0.14+)
- Web visualization dashboard
- PostgreSQL backend support (pg_graph)
- Enhanced embedding support
- Workflow automation templates


## [1.0.1] - 2026-08-27

First patch release of the v1.0 line: a full correctness review of the data
plane, backends, and tooling, with every verified finding fixed and covered by
regression tests (403 → 417 tests). No public CLI or SDK surface changes
(`CONTRACT.md` v1.0 remains intact).

### Fixed — data loss

- **Exports, counts, and migration verification no longer silently truncate
  at 1000 memories.** `searchMemoriesPaginated` derived its total from a
  single count query capped at 1000, so full-graph iteration stopped after
  the first batch and migration verification passed despite missing data.
- **Re-storing a memory no longer deletes its relationships on SQLite.**
  `INSERT OR REPLACE` delete-reinserted the row, firing the foreign-key
  cascade; the upsert now updates in place and preserves the original
  `created_at`.
- **Export/import round-trips are faithful**: relationship bi-temporal
  metadata (`recorded_at`, `valid_from`, `valid_until`, validation stats)
  and memory `created_at`/`updated_at`/`version`/`effectiveness`/
  `usage_count`/`last_accessed` survive a backup/restore or migration.
- **Relationship export no longer caps at 20 edges per memory** on Cypher
  backends; the cap is lifted for export, `as-of`, and history queries
  (`getRelatedMemories` accepts an optional `limit`).

### Fixed — silent wrong answers

- Session briefings, workflow session state, and knowledge-gap queries
  report unsolved problems again: all `EXISTS { MATCH }` subqueries
  (unsupported by FalkorDB v4.16.3) rewritten as `OPTIONAL MATCH` + count.
- File-entity links survive repeated captures of the same file (the link
  now uses the id the MERGE returned, and file entities share the
  intelligence layer's `{text, type}` key).
- `visualize <id>` returns a non-empty centered graph (variable-scope bug
  in the Cypher aggregation).
- `activity` works on the default falkordblite backend (shared Cypher
  implementation for FalkorDB and Bolt backends, with cap surfacing).
- `created_after` / `created_before` / `min_effectiveness` search filters
  are honored by all local backends instead of being silently ignored.
- Contextual search finds related matches that do not rank in the global
  top results.
- Learning features actually learn: pattern propagation traverses
  creatable relationship types, workflow `success_rate` reflects failures
  (was always 100%), and error-pattern frequency / solution effectiveness
  are written instead of only touching `updated_at`.
- `what-changed` sees relationships invalidated since the query time, not
  only newly recorded ones.

### Fixed — Cloudflare Worker (graph-worker)

- RESP encoder declares UTF-8 byte lengths, fixing protocol desync on any
  non-ASCII memory content.
- Query timeouts invalidate the socket (no more response mispairing on the
  inference loop); read timeout now exceeds the query timeout.
- Edge `id`/`type` surfaced when parsing relationships (list endpoints no
  longer report every edge as `RELATED_TO`).
- Invalid query params (`?limit=abc`) and malformed JSON bodies return 4xx
  instead of 500s; tags containing commas survive read-back.
- Auth cache enforces key expiry; Cypher export escaping produces
  re-importable files.

### Fixed — other

- Memgraph is accepted as a migration source/target.
- Bolt schema init surfaces unexpected index failures instead of
  swallowing them; Cloud backend sends `offset: 0` explicitly.
- Entity extraction offsets bracket the entity text, not the match prefix.
- Test-suite flakiness from un-awaited backend connects eliminated.


> Remaining adversarial review findings and port completeness gaps are tracked in `master-plan.md`.

## [0.13.0] - 2026-07-05

### Added — TypeScript Port

Complete rewrite of MemoryGraph from Python MCP server to TypeScript/Bun CLI. The entire codebase was ported, bringing all features to a faster, simpler runtime.

#### TypeScript CLI

- **35+ CLI commands** across 8 categories: memory operations, context search, intelligence, analytics, proactive, integration, temporal, and data management
- **`parseSimpleArgs`** custom arg parser (not `node:util:parseArgs`)
- **`handleToolErrors`** decorator for consistent error handling across all tool handlers
- **Library barrel exports** from `index.ts` for programmatic use
- **Compiled binary** support via `bun build --compile`

#### Backends (5 working)

- **FalkorDBLite** (default, embedded) — zero-config graph database via `BaseFalkorDBBackend`
- **SQLite** — zero-dependency fallback with simulated graph operations
- **FalkorDB** (client-server) — extends `BaseFalkorDBBackend` with shared Cypher logic
- **Memgraph** (client-server) — Bolt protocol via `BaseBoltBackend`
- **Cloud** — REST API client for multi-device sync

#### Intelligence Layer

- **Entity extraction** — regex-based, 12 entity types (FILE, FUNCTION, CLASS, ERROR, TECHNOLOGY, CONCEPT, etc.)
- **Pattern recognition** — find similar problems, suggest reusable patterns
- **Context retrieval** — multi-factor relevance ranking (entities + keywords + recency)

#### Analytics

- Graph visualization data export (D3/vis.js compatible)
- Solution similarity analysis (Jaccard similarity)
- Learning path recommendations
- Knowledge gap identification

#### Proactive

- Session briefings with recent activity and open issues
- Predictive suggestions based on current context
- Issue warning system (deprecated approaches, known errors)
- Outcome learning with effectiveness scoring

#### Integration

- Context capture (task, command, error tracking)
- Project analysis (codebase structure, framework detection)
- Workflow tracking and optimization suggestions

#### Migration

- Backend-to-backend migration with verification
- Supports all working backends as source and target

#### SDK

- Cloud API client for external TypeScript applications

### Changed

- **Runtime**: Python → TypeScript/Bun
- **Interface**: MCP server → CLI (agents invoke shell commands directly)
- **Default backend**: Still FalkorDBLite (was FalkorDBLite in Python v0.12.4)
- **Config**: Static getter class reading `process.env` at call time (was `_EnvVar` descriptors)
- **Backends**: Shared base classes (`BaseFalkorDBBackend`, `BaseBoltBackend`) replace Python `_falkordb_shared.py`
- **Documentation**: README rewritten for TypeScript CLI, CLAUDE.md and AGENTS.md condensed for token efficiency

### Removed

- Python codebase (303 files, -79,580 lines)
- MCP server protocol (replaced by direct CLI)
- pip/pipx packaging
- Docker Compose configurations for server deployment
- Python-specific test infrastructure

### Testing

- **97 tests** across 12 test files, all passing
- **242 expect() calls**
- **Typecheck clean** (`tsc --noEmit`)
- Test files: activity-tools, cli-commands, config, context-retrieval, entity-extraction, export-import, falkordb-backends, migration, models, pattern-recognition, sqlite-backend, temporal

### Stats

- **303 files changed**, +15,762 / -79,580 lines
- Net reduction: 63,818 lines (Python codebase removed, TypeScript port is more concise)

## [0.12.4] - 2026-02-12

### Added
- **FalkorDB Shared Base Class** (`src/memorygraph/backends/_falkordb_shared.py`): Extracts all shared logic between FalkorDB and FalkorDBLite into a single base class, eliminating 95% code duplication
- **Config `_EnvVar` Descriptors** (`src/memorygraph/config.py`): Descriptor-based configuration with `is_set()` to distinguish unset from default values
- **Factory Dispatch Tables** (`src/memorygraph/backends/factory.py`): Dict-based dispatch replaces if/elif chains for backend creation, validation, and info
- **Config Summary**: FalkorDB/FalkorDBLite connection details now included in `memorygraph config` output
- **New Test Files**:
  - `tests/backends/test_falkordb_shared.py` — shared base class coverage (540 lines)
  - `tests/backends/test_backend_imports.py` — import verification for all backend modules
  - `tests/test_simplification.py` — dispatch table and deduplication validation
  - `tests/test_backend_config.py` — Config-as-single-source-of-truth tests
  - `tests/test_factory_config.py` — factory dispatch table coverage

### Changed
- **Config is Single Source of Truth**: Removed redundant default fallbacks from all 5 backend files — backends now read exclusively from `Config`
- **CLI Env-Only Config**: `cli.py` writes only to `os.environ`, eliminating dual-writes to Config object
- **CLI Shared Backend Helper**: Extracted `_create_backend()` to reduce repetition across CLI commands
- **Consolidated `patch_config` Fixture**: Single definition in `tests/conftest.py` replaces 19 duplicates across test files
- **Shared FalkorDB Test Helpers**: Reusable fixtures in `tests/backends/conftest.py` for both FalkorDB and FalkorDBLite
- **Backend Files Simplified**: Removed redundant docstrings, comments, and dead code across cloud, neo4j, memgraph, falkordb backends (net -2,141 source lines)

### Fixed
- **Invalid Cypher in FalkorDB `delete_memory`**: `COUNT` after `DETACH DELETE` produced incorrect results — now uses two-query approach
- **Backend Auto-Detection Broken by Config Defaults**: `NEO4J_URI` default made auto-detection think Neo4j was configured — fixed with `_EnvVar.is_set()`
- **`_EnvVar` Empty String Handling**: `MEMORYGRAPH_BACKEND=""` now consistently treated as unset
- **CLI Diagnostic Output**: All diagnostic messages routed to stderr, emoji removed for clean piping
- **FalkorDB Result Parsing**: Fixed result extraction from FalkorDB query responses
- **Vacuous Tests**: Identified and fixed tests that passed but tested nothing meaningful

### Testing
- **Total Tests**: 1,578 → 2,220 (+642 tests)
- **Skipped Tests**: 139 → 57 (more tests now runnable)
- **Runtime**: 24.27s, zero failures
- **87 files changed**: +16,012 / -12,246 lines (since v0.12.2)

## [0.12.2] - 2026-02-09

### Fixed
- **Neo4j Test Compatibility**: Fixed memgraph tests to use `ClientError` and original `Neo4jError` class in CI

## [0.12.1] - 2026-02-09

### Fixed
- **Neo4j Test Compatibility**: Fixed memgraph backend tests to use `ClientError`

## [0.12.0] - 2025-12-23

### Added
- **MemoryOperations Protocol** (`src/memorygraph/protocols.py`): Type-safe interface defining common operations all backends must support
- **Tool Handler Registry** (`src/memorygraph/tools/registry.py`): Clean mapping of tool names to handlers, replacing if/elif chain
- **Error Handling Decorator** (`src/memorygraph/tools/error_handling.py`): `@handle_tool_errors` decorator for consistent error handling across all tool handlers
- **Input Validation** (`src/memorygraph/utils/validation.py`): Content size limits (50KB max), tag normalization with Pydantic field validators
- **Datetime Utilities** (`src/memorygraph/utils/datetime_utils.py`): Centralized timezone-aware datetime handling
- **Backend Capability Detection**: `is_cypher_capable()` method on all backends for runtime capability checking
- **ADR-018**: Architecture Decision Record documenting CloudBackend type hierarchy refactoring

### Changed
- **CloudBackend Refactored**: Renamed internally to `CloudRESTAdapter` with backwards-compatible `CloudBackend` alias
- **Tool Handlers Simplified**: All handlers now use `@handle_tool_errors` decorator, reducing boilerplate by ~40%
- **Server Handler**: Uses tool registry for cleaner dispatch logic
- **Datetime Handling**: All code now uses `datetime.now(timezone.utc)` instead of deprecated `datetime.utcnow()`

### Fixed
- **LSP Violation**: CloudBackend no longer violates Liskov Substitution Principle (documented in ADR-018)
- **Timezone Safety**: Fixed naive vs aware datetime comparison issues in tests and production code
- **SDK Model Sync**: SDK models now properly synchronized with server models

### Testing
- **Coverage Improved**: 70% → 81% (above 80% target)
- **New Test Files**:
  - `tests/test_cli_coverage.py` - CLI module (92% coverage)
  - `tests/backends/test_factory_coverage.py` - Backend factory (99% coverage)
  - `tests/tools/test_activity_tools_coverage.py` - Activity tools (98% coverage)
  - `tests/tools/test_temporal_tools_coverage.py` - Temporal tools (96% coverage)
  - `tests/tools/test_error_handling.py` - Error decorator (100% coverage)
  - `tests/tools/test_registry.py` - Tool registry (100% coverage)
  - `tests/tools/test_validation.py` - Input validation (100% coverage)
  - `tests/analytics/test_advanced_queries_coverage.py` - Analytics (96% coverage)
  - `tests/test_cloud_database_coverage.py` - Cloud database (100% coverage)
  - `tests/test_sqlite_database_coverage.py` - SQLite database (85% coverage)
- **Total Tests**: 1,578 passing, 49 skipped (neo4j optional dependency)

## [0.11.13] - 2025-12-23

### Changed
- **Tool Descriptions Optimized for Retrieval**: Updated MCP tool descriptions to guide LLMs on when to use `recall_memories` vs `search_memories`
  - `recall_memories`: Added "BEST FOR" (conceptual queries, fuzzy matching) and "LESS EFFECTIVE FOR" (acronyms, proper nouns) sections
  - `search_memories`: Changed guidance to "USE THIS TOOL FIRST (not recall) when searching for: Acronyms, Proper nouns, Known tags, Technical terms"
  - `store_memory`: Added "TAGGING BEST PRACTICE" section encouraging acronyms as tags for reliable retrieval
  - Fixes issue where `recall_memories` underperformed for acronyms (DCAD, JWT, API) while `search_memories` with tags filter found results reliably

## [0.11.12] - 2025-12-12

### Changed
- **Token Optimization**: Further optimizations for context efficiency
- **Test Coverage**: Comprehensive test coverage improvements

## [0.11.11] - 2025-12-09

### Fixed
- **Cloud Backend `get_recent_activity`**: Fixed `'dict' object has no attribute 'title'` error
  - Cloud backend now converts API response dicts to Memory objects using `_api_response_to_memory()`
  - Returns proper empty response structure when no results
- **Activity Tools**: Added defensive `_get_memory_attr()` helper function
  - Handles both Memory objects and dict representations
  - Properly extracts enum values (e.g., `type.value`)
- **Migration Manager**: Added CloudMemoryDatabase support for cloud backend migrations
- **CLI Migration**: Added MEMORYGRAPH_API_KEY environment variable support for cloud backend target

## [0.11.10] - 2025-12-09

### Changed
- **Tool Descriptions Optimized**: Reduced tool description token overhead by ~16%
  - Streamlined descriptions to match peer MCP server patterns (~891 tokens/tool avg, down from ~1,063)
  - Removed verbose "WHEN TO USE", "WHY IT MATTERS", and "RETURNS" sections
  - Reduced examples from 4 to 2-3 per tool while maintaining clarity
  - Kept essential guidance: clear purpose, practical examples, key parameter info

## [0.11.9] - 2025-12-09

### Fixed
- **LlamaIndex Integration**: Added `from_defaults` classmethod to `MemoryGraphChatMemory`
  - Fixes `TypeError: Can't instantiate abstract class MemoryGraphChatMemory with abstract method from_defaults`
  - Required due to LlamaIndex `BaseMemory` interface change requiring this method
  - Follows LlamaIndex convention (e.g., `ChatMemoryBuffer.from_defaults()`)

## [0.11.8] - 2025-12-09

### Fixed
- **Cloud Backend**: Fixed API endpoint paths for graph-api.memorygraph.dev
  - `search_memories`: Changed from `/memories/search` to `/search/advanced`
  - `recall_memories`: Changed from `/memories/recall` to `/search/recall`
  - `get_related_memories`: Changed from `/memories/{id}/related` to `/search/memories/{id}/related`
- **Activity Tools**: Changed `isinstance()` checks to `hasattr()` for better backend compatibility
  - `get_recent_activity` and `search_relationships_by_context` now work with any backend that implements the required methods
  - Removed tight coupling to `SQLiteMemoryDatabase`

### Changed
- Updated test mocks to use new cloud API endpoint paths

## [0.11.7] - 2025-12-09

### Fixed
- **Cloud Backend**: Added `CloudMemoryDatabase` wrapper class that delegates to `CloudBackend`'s REST API methods instead of trying to use Cypher queries directly

## [0.10.0] - 2025-12-08

### Added
- **Cloud Backend**: Production-ready cloud backend with circuit breaker pattern
  - Multi-device sync via memorygraph.dev
  - Team collaboration support
  - Automatic retry with exponential backoff
  - Health monitoring and connection pooling
- **Bi-Temporal Tracking**: Track knowledge evolution over time
  - `valid_from`, `valid_until`, `recorded_at`, `invalidated_by` fields
  - Point-in-time queries via Python API
  - Migration support for existing databases
  - Temporal query tools for historical analysis
- **Context Budget Optimization**: 60-70% token reduction
  - Removed 29 unimplemented tools
  - ADR-017: Context budget as architectural constraint
  - Core profile: 9 tools, Extended: 12 tools
  - Improved token efficiency for Claude Code
- **Semantic Navigation**: Contextual search without embeddings
  - Natural language query understanding
  - Entity-based relationship traversal
  - Pattern matching for code concepts
- **MCP SDK Upgrade**: Updated to MCP Python SDK 1.23.1
  - Full support for MCP specification 2025-11-25
  - Claude Code Web compatibility via project hooks
  - Auto-installation in remote environments
- **Turso Backend**: Cloud-persistent SQLite-compatible storage
  - Environment variables support both `TURSO_*` and `MEMORYGRAPH_TURSO_*` prefixes
  - Seamless migration from SQLite
  - Example configurations in `examples/claude-code-hooks/`

### Changed
- Tool profiles simplified: Core (9 tools) and Extended (12 tools)
- Backend factory now supports `turso` and `cloud` backend types
- Test count: 1,068 tests passing (improved from 910)
- Documentation reorganization (completed workplans archived)
- Deprecated temporal MCP tools in favor of Python API access

### Removed
- 29 vaporware (unimplemented) tools moved to experimental/
- Temporal MCP tools deferred to Python API only (ADR-017)

### Documentation
- Added `docs/claude-code-web.md` for Claude Code Web setup
- Updated deployment guide with cloud backend configuration
- Workplan tracking moved to memorygraph.dev

## [0.8.1] - 2025-12-01

### Fixed
- Fixed FalkorDB integration tests failing in CI/CD when packages not installed
- Integration tests now properly skip (not fail) when FalkorDB/FalkorDBLite unavailable
- Fixed mock contamination between unit tests and integration tests

### Added
- Comprehensive documentation for encouraging memory creation
- New `docs/examples/CLAUDE_MD_EXAMPLES.md` with ready-to-use templates
- Memory best practices section in README
- CLAUDE.md configuration examples for proactive memory storage

## [0.8.0] - 2025-12-01

### Added - FalkorDB Backend Support

**New Graph Database Backends**: Added two new high-performance graph database backends powered by FalkorDB.

#### FalkorDBLite Backend (Embedded)
- **Zero-config embedded graph database**: Like SQLite but with native Cypher queries
- **Native graph operations**: No NetworkX translation layer, true graph database performance
- **Embedded deployment**: Single file, no external server required
- **Installation**: `pip install memorygraphMCP[falkordblite]`
- **Configuration**: Set `MEMORY_BACKEND=falkordblite`, optionally set `FALKORDBLITE_PATH`
- **Use case**: Best for developers who want native graph database features without server setup
- **Performance**: Faster than SQLite+NetworkX for complex graph traversals

#### FalkorDB Backend (Client-Server)
- **High-performance graph database**: 500x faster p99 latency than Neo4j (per FalkorDB benchmarks)
- **Redis-based**: Built on Redis for exceptional throughput and low latency
- **Client-server architecture**: Connect to user-managed FalkorDB instance
- **Installation**: `pip install memorygraphMCP[falkordb]`
- **Configuration**: Set `MEMORY_BACKEND=falkordb`, `FALKORDB_HOST`, `FALKORDB_PORT`, `FALKORDB_PASSWORD`
- **Use case**: Production deployments needing high-performance graph operations
- **Deployment**: Users must deploy FalkorDB separately (Docker recommended)

#### Backend Comparison (Updated)
MemoryGraph now supports **5 backend options**:
1. **SQLite** (default) - Zero-config, 10k memories, embedded
2. **FalkorDBLite** (new) - Zero-config, native graph, embedded
3. **FalkorDB** (new) - High-performance, client-server, 500x faster than Neo4j
4. **Neo4j** - Enterprise graph database, proven at scale
5. **Memgraph** - In-memory graph database, fastest analytics

#### Implementation Details
- **42 new tests**: 21 FalkorDB backend tests + 21 FalkorDBLite backend tests (all passing)
- **Backend abstraction**: Both backends implement `GraphBackend` interface
- **Cypher compatibility**: Full Cypher query support with FalkorDB dialect
- **Error handling**: Comprehensive exception wrapping and connection management
- **Lazy imports**: Optional dependencies loaded only when backend selected
- **Backend factory**: Automatic backend selection with `MEMORY_BACKEND` environment variable

#### Testing & Quality
- **Total tests**: 910 (893 passing, 13 expected integration test skips, 4 skipped)
- **New tests**: 42 comprehensive unit tests for both FalkorDB backends
- **Integration tests**: Properly skip when FalkorDB not installed (expected behavior)
- **No regressions**: All existing backend tests continue to pass
- **Code review**: Zero issues found in comprehensive review
- **Benchmark script**: Added `/scripts/benchmark_backends.py` for performance validation

#### Documentation
- **README.md**: Updated with FalkorDB backends, installation examples, performance notes
- **DEPLOYMENT.md**: Added FalkorDB and FalkorDBLite sections with configuration examples
- **CONFIGURATION.md**: Added environment variable documentation for both backends
- **TROUBLESHOOTING.md**: Added FalkorDB-specific troubleshooting (libomp on macOS, connection issues)
- **User responsibility**: Clear documentation that FalkorDB client-server deployment is user-managed

#### Performance
- **FalkorDBLite**: Native graph operations without NetworkX overhead
- **FalkorDB**: Exceptionally low latency (500x faster p99 than Neo4j per vendor benchmarks)
- **Benchmark script**: Included for users to validate performance on their deployment

#### Breaking Changes
None - all existing backends continue to work unchanged.

#### Migration Guide
No migration needed for existing users. New users can choose FalkorDB backends:
- `MEMORY_BACKEND=falkordblite` - Embedded graph database (zero-config)
- `MEMORY_BACKEND=falkordb` - Client-server (requires FalkorDB instance)

#### Dependencies
- Added `falkordblite>=1.0.0` to optional dependencies
- Added `falkordb>=1.0.0` to optional dependencies
- Both included in `all` extras: `pip install memorygraphMCP[all]`

### Enhanced
- Backend ecosystem expanded from 3 to 5 options
- Badge updated from "3 Backends" to "5 options"
- Backend comparison table now includes all 5 backends
- Performance characteristics documented for each backend

### Documentation
- Consolidated workplan documents into single unified WORKPLAN.md
- Archived completed Phase 8 tasks to docs/archive/completed-tasks-2025-01.md
- Removed duplicate marketing documentation (marketing-plan.md, MARKETING_EXECUTIVE_SUMMARY.md)
- Centralized all active tasks in WORKPLAN.md for easier tracking

## [2.0.0] - 2025-11-28

### BREAKING CHANGES - Project Renamed to MemoryGraph

**Project renamed from `claude-code-memory` to `memorygraph`** to better reflect universal MCP compatibility. Originally built for Claude Code, MemoryGraph now emphasizes its support for any MCP-enabled coding agent (Cursor, Continue, etc.).

#### What Changed

**Package & CLI**:
- Package name: `claude-code-memory` → `memorygraph`
- CLI command: `claude-memory` → `memorygraph`
- Python module: `claude_memory` → `memorygraph`
- Default database path: `~/.claude-memory/` → `~/.memorygraph/`

**Branding**:
- Project name: "Claude Code Memory Server" → "MemoryGraph"
- Subtitle: "MCP Memory Server for AI Coding Agents"
- Positioning: Generic MCP server, compatible with any MCP-enabled coding agent
- Documentation: Updated to emphasize MCP standard and universal compatibility

**Repository** (to be updated):
- GitHub: `gregorydickson/claude-code-memory` → `gregorydickson/memorygraph`
- PyPI: `claude-code-memory` → `memorygraph`

#### Why This Change?

- **Better Branding**: More descriptive, not Claude-specific
- **Universal MCP Compatibility**: Works with any MCP-enabled coding agent
- **Professional Naming**: "MemoryGraph" describes functionality (graph-based memory)
- **Broader Audience**: Appeals to all MCP client users, not just Claude Code

#### Migration Required

**For Existing Users**: See [MIGRATION.md](MIGRATION.md) for complete upgrade guide.

**Quick Migration**:
1. `pip uninstall claude-code-memory && pip install memorygraphMCP`
2. Update MCP config: `"claude-memory"` → `"memorygraph"`
3. Move database: `mv ~/.claude-memory ~/.memorygraph` (or use `MEMORY_SQLITE_PATH` env var)
4. Restart your coding agent

#### What Stayed the Same?

- All features and functionality
- Environment variables (still use `MEMORY_*` prefix)
- Database schema and compatibility
- All 44 MCP tools
- Backend support (SQLite, Neo4j, Memgraph)
- **Still optimized for Claude Code**, but now explicitly supports all MCP clients

---

## [1.0.0] - 2025-11-28

### Production Release - Phase 8: Deployment & Production Readiness

#### Major Features
- **Zero-Config Default**: SQLite backend with no setup required
- **Three-Tier Complexity Model**: Lite (8 tools) → Standard (15 tools) → Full (44 tools)
- **Multi-Backend Support**: SQLite (default), Neo4j, and Memgraph
- **Tool Profiling System**: Choose complexity level via `MEMORY_TOOL_PROFILE` env var
- **CLI Command**: `memorygraph` with flags for backend, profile, and logging
- **Docker Support**: Complete Docker Compose configurations for all backends
- **PyPI Publication**: Install via `pip install memorygraphMCP`

#### Added
- **SQLite Backend as Default**:
  - Zero configuration required
  - NetworkX for graph operations
  - Optimized for <10k memories
  - WAL mode, connection pooling, indexes
  - Full feature parity with graph backends

- **Tool Profiling**:
  - `lite` profile: 8 core tools (default)
  - `standard` profile: 15 tools (core + intelligence)
  - `full` profile: All 44 tools (graph analytics, workflows, proactive AI)
  - Environment variable: `MEMORY_TOOL_PROFILE`
  - CLI flag: `--profile lite|standard|full`

- **CLI Implementation**:
  - Entry point: `memorygraph` command
  - Flags: `--backend`, `--profile`, `--log-level`
  - Commands: `--version`, `--show-config`, `--health`
  - Helpful error messages and validation

- **Docker Deployment**:
  - Base Dockerfile (Python 3.11-slim)
  - `docker-compose.yml` - SQLite mode (default)
  - `docker-compose.neo4j.yml` - Neo4j with Browser
  - `docker-compose.full.yml` - Memgraph with Lab
  - Health checks and optimized settings

- **Documentation Overhaul**:
  - README.md: Completely rewritten, beginner-friendly
  - Quick Start section (30-second setup)
  - "Choose Your Mode" comparison table
  - Feature badges (Zero Config, 3 Backends, etc.)
  - MCP specification introduction explaining open standard architecture
  - Multiple example MCP configurations (8 examples covering all modes)
  - FULL_MODE.md: Advanced features guide
  - DEPLOYMENT.md: Complete deployment guide
  - CLAUDE_CODE_SETUP.md: Step-by-step integration
  - TOOL_PROFILES.md: Complete tool reference

- **uvx Support** (Documentation):
  - Package works with `uvx memorygraph` out of the box
  - Option 3 in installation methods for quick testing
  - Installation method comparison table
  - CI/CD integration examples (GitHub Actions, GitLab CI)
  - Clear guidance: uvx for testing, pip for production
  - Warning against using uvx for persistent MCP servers

- **Package Configuration**:
  - Version: 1.0.0
  - Updated repository URLs (gregorydickson)
  - Optional dependencies: neo4j, memgraph, intelligence, dev, all
  - Python 3.10+ support
  - MIT License
  - Production/Stable status

#### Changed
- **Default Backend**: Neo4j → SQLite (for zero-config experience)
- **Default Profile**: Full → Lite (8 tools, simpler onboarding)
- **Repository Owner**: ViralV00d00 → gregorydickson
- **Architecture**: Modular backend factory pattern
- **Tool Registration**: All 44 tools registered with profile filtering

#### Backend Compatibility
- **SQLite**: All 44 tools supported (default)
- **Neo4j**: All 44 tools supported (optimal for production)
- **Memgraph**: All 44 tools supported (fastest analytics)

#### Test Status
- Total tests: 409
- Passing: 401/409 (98%)
- Coverage: 93%
- Backends tested: SQLite, Neo4j, Memgraph

#### Breaking Changes
- Default backend changed from Neo4j to SQLite
- Environment variable `NEO4J_URI` no longer required by default
- Tool profile filtering may hide tools in lite/standard modes

#### Migration Guide
- Existing users: Set `MEMORY_BACKEND=neo4j` to keep current setup
- New users: Zero config required, just `pip install memorygraphMCP`
- Upgrading profiles: No data migration needed, just change `MEMORY_TOOL_PROFILE`

#### Deployment Options
1. **pip install** (recommended): `pip install memorygraphMCP`
2. **Docker**: `docker compose up -d`
3. **From source**: `git clone && pip install -e .`
4. **uvx** (testing/CI): `uvx memorygraph`

#### Performance
- SQLite: <100ms queries for 10k memories
- Neo4j: 10x faster graph operations at scale
- Memgraph: 100x faster complex analytics

## [0.6.0] - 2025-11-28

### Added - Phase 7: Proactive Features & Advanced Analytics

- **Session Start Intelligence**: Automatic briefings when Claude Code starts
  - Project detection and context loading
  - Recent activity summary (last 7 days)
  - Unresolved problems identification
  - Relevant pattern suggestions with effectiveness scores
  - Deprecation warnings for outdated approaches
  - Configurable verbosity (minimal/standard/detailed)
  - MCP tool: `get_session_briefing`
  - MCP resource: `memory://session/briefing/{project_name}`

- **Predictive Suggestions Engine**: Proactive suggestions based on current context
  - Entity-based suggestion matching
  - Pattern relevance scoring with transparency
  - Related context discovery ("You might also want to know...")
  - Evidence-based recommendations with source attribution
  - MCP tools: `get_suggestions`, `suggest_related_memories`

- **Issue Warning System**: Proactive issue detection
  - Deprecated approach detection using DEPRECATED_BY relationships
  - Known problem pattern matching
  - Severity-based filtering (low/medium/high)
  - Mitigation suggestions for identified issues
  - MCP tool: `check_for_issues`

- **Outcome Learning System**: Track and learn from solution effectiveness
  - Outcome recording (success/failure with context)
  - Effectiveness score updates using Bayesian updating
  - Pattern effectiveness propagation with dampening
  - Confidence scoring based on usage history
  - Designed decay mechanism (documented, not yet implemented)
  - MCP tool: `record_outcome`

- **Advanced Analytics Queries**: Insights into knowledge graph structure
  - Graph visualization data export (D3/vis.js compatible)
  - Solution similarity analysis using Jaccard similarity
  - Solution effectiveness prediction
  - Learning path recommendations
  - Knowledge gap identification (unsolved problems, sparse entities)
  - Memory ROI tracking (value scoring, usage statistics)
  - MCP tools: `get_graph_visualization`, `find_similar_solutions`,
    `predict_solution_effectiveness`, `recommend_learning_paths`,
    `identify_knowledge_gaps`, `track_memory_roi`

- **Architecture & Documentation**:
  - ADR 008: Proactive Intelligence Architecture
  - 63 new tests (55 passing, 87% quality)
  - Comprehensive module documentation
  - Backend-agnostic implementation
  - Total test count: 409 (346 + 63 new)

### Changed
- Architecture health score: A+ (98/100)
- Total MCP tools: 30 (19 core + 11 proactive)
- Overall test coverage: 90%+ maintained

## [0.5.0] - 2025-11-28

### Added - Phase 6: Claude Code Integration
- **Context Capture Module**: Automatic development context tracking
  - Task context capture (description, goals, files involved)
  - Command execution tracking (command, output, error, success)
  - Error pattern analysis with frequency tracking
  - Solution effectiveness tracking
  - Privacy-first: automatic sanitization of API keys, passwords, tokens, emails
  - 99% test coverage

- **Project Analysis Module**: Project-aware memory intelligence
  - Project detection from config files (8 language types supported)
  - Codebase analysis (file counts, languages, frameworks)
  - Git integration for file change tracking
  - Code pattern identification (API endpoints, classes, async patterns)
  - Framework detection (React, Vue, FastAPI, Django, etc.)
  - 88% test coverage

- **Workflow Tracking Module**: Development workflow optimization
  - Workflow action tracking with session management
  - Workflow suggestions based on successful patterns
  - Optimization recommendations (slow actions, repeated failures)
  - Session state management for continuity
  - Next-step suggestions based on context
  - 96% test coverage

- **11 New MCP Tools for Integration**:
  - `capture_task`: Capture task context
  - `capture_command`: Capture command execution
  - `track_error_solution`: Track solution effectiveness
  - `detect_project`: Detect project information
  - `analyze_project`: Analyze codebase structure
  - `track_file_changes`: Track git changes
  - `identify_patterns`: Identify code patterns
  - `track_workflow`: Track workflow actions
  - `suggest_workflow`: Get workflow suggestions
  - `optimize_workflow`: Get optimization recommendations
  - `get_session_state`: Get current session state

- **75 New Integration Tests**: Comprehensive test suite
  - 27 context capture tests
  - 18 project analysis tests
  - 30 workflow tracking tests
  - All tests passing (100% pass rate)
  - Total test count: 346 (271 + 75 new)

- **Security Features**:
  - Automatic redaction of sensitive data patterns
  - Safe subprocess handling with timeouts
  - Graceful handling of missing git repositories
  - No credential leaking into memories

### Enhanced
- Memory type system: Added task, observation, file_change, error_pattern, workflow_action, code_pattern
- Entity types: Added session, file, project entities
- Relationship usage: Leverages existing types (PART_OF, INVOLVES, EXECUTED_IN, EXHIBITS, SOLVES, IN_SESSION, FOLLOWS)

### Documentation
- ADR 007: Claude Code Integration Architecture
- Updated enhancement plan with Phase 6 completion
- Integration module documentation
- Security sanitization patterns documented

## [0.4.0] - 2025-11-28

### Added - Phase 5: Intelligence Layer
- **Entity Extraction Module**: Automatic entity identification from memory content
  - Support for 12 entity types (FILE, FUNCTION, CLASS, ERROR, TECHNOLOGY, CONCEPT, etc.)
  - Regex-based pattern matching with 82% coverage
  - Optional NLP support via spaCy
  - Confidence scoring and deduplication
  - Automatic entity linking with MENTIONS relationships

- **Pattern Recognition Module**: Identify reusable patterns from accumulated memories
  - Find similar problems using keyword/entity matching
  - Extract common patterns from entity co-occurrences
  - Pattern confidence scoring based on frequency
  - Context-aware pattern suggestions
  - 95% test coverage

- **Temporal Memory Module**: Track how information changes over time
  - Version history traversal via PREVIOUS relationships
  - Point-in-time state queries
  - Entity timeline tracking
  - Version diff comparison
  - 97% test coverage

- **Context-Aware Retrieval Module**: Intelligent context assembly
  - Multi-factor relevance ranking (entities + keywords + recency)
  - Token-limited context formatting
  - Project-scoped context retrieval
  - Session briefings (last 24 hours)
  - Relationship traversal for related context

- **94 New Intelligence Tests**: Comprehensive test coverage
  - 28 entity extraction tests
  - 23 pattern recognition tests
  - 21 temporal memory tests
  - 22 context retrieval tests
  - All passing with high coverage (82-97%)

- **7 New MCP Tools**:
  - `find_similar_solutions`: Find similar problems and their solutions
  - `suggest_patterns_for_context`: Get relevant pattern suggestions
  - `get_memory_history`: View version history for a memory
  - `track_entity_timeline`: Track entity usage over time
  - `get_intelligent_context`: Smart context retrieval with ranking
  - `get_project_summary`: Comprehensive project overview
  - `get_session_briefing`: Recent activity summary

### Features
- **Smart Entity Recognition**: Automatically identify technologies, errors, files, concepts
- **Pattern Learning**: Extract reusable patterns from successful solutions
- **Version Tracking**: Complete audit trail of how memories evolve
- **Intelligent Ranking**: Relevance-based context with entity + keyword + recency scoring
- **Backend Agnostic**: All intelligence features work across Neo4j, Memgraph, SQLite

### Architecture
- Modular intelligence layer with 4 specialized modules
- Clean separation of concerns (extraction, recognition, temporal, retrieval)
- Extensible design for future ML/NLP enhancements
- Zero-dependency core with optional advanced features

### Documentation
- `docs/adr/006-intelligence-layer-architecture.md`: ADR for intelligence design
- Comprehensive module docstrings with examples
- Type hints on all public APIs
- Usage examples for all MCP tools

### Performance
- Entity extraction: <100ms for typical memory
- Pattern recognition: <200ms with 1000+ memories
- Context retrieval: <500ms for complex queries
- Temporal queries: <100ms for version chains

### Test Metrics
- **Total Tests**: 271 (up from 177)
- **Pass Rate**: 100%
- **Intelligence Coverage**: 82-97% across modules
- **Overall Coverage**: 66%

## [0.3.0] - 2025-11-27

### Added - Phase 3: Multi-Backend Support
- **Abstract Backend Layer**: Introduced `GraphBackend` interface for database abstraction
- **Neo4j Backend**: Refactored existing Neo4j code into `neo4j_backend.py` implementing GraphBackend
- **Memgraph Backend**: Added full Memgraph support using Bolt protocol and Cypher compatibility
- **SQLite Fallback**: Implemented zero-dependency SQLite + NetworkX fallback backend
- **Backend Factory**: Automatic backend selection with priority-based fallback (Neo4j → Memgraph → SQLite)
- **Configuration System**: Centralized configuration with multi-backend environment variables
- **36 New Backend Tests**: Comprehensive test suite for all backend implementations
  - 19 Neo4j backend tests
  - 17 Backend factory tests

### Features
- **Automatic Backend Selection**: `MEMORY_BACKEND=auto` tries backends in order until one connects
- **Explicit Backend Selection**: Support for `neo4j`, `memgraph`, `sqlite` via env var
- **Zero Setup Option**: SQLite fallback requires no external database
- **Cypher Dialect Adaptation**: Automatic query translation for Memgraph compatibility
- **Health Checks**: Backend health monitoring with connection status and statistics

### Configuration
- New environment variables for multi-backend support:
  - `MEMORY_BACKEND`: Backend selection (neo4j|memgraph|sqlite|auto)
  - `MEMORY_NEO4J_URI`, `MEMORY_NEO4J_USER`, `MEMORY_NEO4J_PASSWORD`
  - `MEMORY_MEMGRAPH_URI`, `MEMORY_MEMGRAPH_USER`, `MEMORY_MEMGRAPH_PASSWORD`
  - `MEMORY_SQLITE_PATH`: SQLite database file location
  - Backward compatibility with `NEO4J_*` environment variables

### Documentation
- `docs/CYPHER_COMPATIBILITY.md`: Comprehensive guide to Cypher dialect differences
- Backend comparison matrix with feature support
- Migration guide between backends
- Performance considerations for each backend

### Technical Details
- All backends implement identical `GraphBackend` interface
- Neo4j backend supports full-text search with FULLTEXT INDEX
- Memgraph backend with Cypher dialect adaptations
- SQLite backend uses FTS5 for full-text search, NetworkX for graph operations
- Async/await throughout all backend implementations
- Connection pooling and retry logic in Neo4j/Memgraph backends

### Testing
- Test coverage maintained at 76% (now covering 98 tests)
- All 98 tests passing (100% pass rate)
- Backend-specific test suites with mocking
- Integration tests verify cross-backend compatibility

### Breaking Changes
- None - existing Neo4j deployments continue to work without changes
- Default behavior unchanged when using existing `NEO4J_*` environment variables

## [0.2.0] - 2025-11-27

### Added - Phase 2.5: Technical Debt Resolution
- Custom exception hierarchy with detailed error information
- Comprehensive error handling across all modules
- AsyncIO refactoring for all database operations
- Full MCP protocol compliance with isError flags
- 62 comprehensive unit tests across all modules:
  - 28 database tests (Neo4j connection, CRUD, relationships, statistics)
  - 19 server tests (MCP handlers, validation, error handling)
  - 8 exception tests (custom exceptions, error hierarchy)
  - 7 model tests (Pydantic validation, serialization)

### Fixed
- All async database operations now properly use AsyncIO
- Server handlers correctly set isError=True for error responses
- Comprehensive exception handling in all handler methods
- Mock return values aligned with actual implementation
- API parameter names standardized (depth → max_depth, memory_type → type)

### Improved
- Test coverage increased from 67% to 76%:
  - database.py: 65% → 71%
  - server.py: 38% → 63%
  - models.py: 97%
- All 62 tests passing (100% pass rate)
- Better error messages with context and validation details
- Consistent exception handling patterns

### Technical Debt Paid
- ✅ Async refactoring complete
- ✅ Custom exceptions implemented
- ✅ Test infrastructure created
- ✅ Error handling standardized
- ✅ MCP protocol compliance verified

## [0.1.0] - 2025-06-28

### Added
- Initial project setup with Python packaging (pyproject.toml)
- Comprehensive Neo4j-based MCP memory server implementation
- Complete data models with Pydantic validation
- 8 core MCP tools for memory management:
  - `store_memory` - Store memories with context and metadata
  - `get_memory` - Retrieve specific memories by ID
  - `search_memories` - Advanced search with filtering
  - `update_memory` - Modify existing memories
  - `delete_memory` - Remove memories and relationships
  - `create_relationship` - Link memories with typed relationships
  - `get_related_memories` - Find connected memories
  - `get_memory_statistics` - Database analytics
- Advanced relationship system with 7 categories and 35 relationship types:
  - **Causal**: CAUSES, TRIGGERS, LEADS_TO, PREVENTS, BREAKS
  - **Solution**: SOLVES, ADDRESSES, ALTERNATIVE_TO, IMPROVES, REPLACES
  - **Context**: OCCURS_IN, APPLIES_TO, WORKS_WITH, REQUIRES, USED_IN
  - **Learning**: BUILDS_ON, CONTRADICTS, CONFIRMS, GENERALIZES, SPECIALIZES
  - **Similarity**: SIMILAR_TO, VARIANT_OF, RELATED_TO, ANALOGY_TO, OPPOSITE_OF
  - **Workflow**: FOLLOWS, DEPENDS_ON, ENABLES, BLOCKS, PARALLEL_TO
  - **Quality**: EFFECTIVE_FOR, INEFFECTIVE_FOR, PREFERRED_OVER, DEPRECATED_BY, VALIDATED_BY
- Neo4j database connection and management with connection pooling
- Comprehensive schema documentation and API reference
- GitHub project management with issues, labels, and milestones
- Complete implementation plan with 7-phase roadmap
- Test suite foundation with model validation tests
- Docker-ready configuration with environment variable support

### Documentation
- README.md with complete project overview and usage instructions
- Schema documentation with all node types and relationships
- Implementation plan with detailed phase breakdown
- API documentation for all MCP tools
- Development setup and configuration guide

### Infrastructure
- GitHub repository with proper issue tracking
- Git workflow with semantic commit messages
- Automated schema initialization
- Performance optimization with indexes and constraints
- Error handling and logging throughout

### Dependencies
- mcp>=1.0.0 - Model Context Protocol SDK
- neo4j>=5.0.0 - Neo4j Python driver
- pydantic>=2.0.0 - Data validation and parsing
- python-dotenv>=1.0.0 - Environment variable management

## Project Milestones

### Phase 1: Foundation Setup ✅ COMPLETED (2025-06-28)
- **Issues Closed**: #1, #2, #3
- **Commits**: 2 major commits with 12 files added
- **Status**: All core infrastructure and basic MCP server operational

### Phase 2: Core Memory Operations 🔄 IN PROGRESS
- **Target**: January 2025
- **Focus**: CRUD operations, entity management, basic relationships
- **Issues**: #12-25 (to be created)

### Phase 3: Advanced Relationship System 📋 PLANNED
- **Target**: February 2025
- **Focus**: All 35 relationship types, weighted properties, intelligence

### Phase 4: Claude Code Integration 📋 PLANNED
- **Target**: February-March 2025
- **Focus**: Development context capture, workflow integration

### Phase 5: Advanced Intelligence 📋 PLANNED
- **Target**: March-April 2025
- **Focus**: Pattern recognition, automatic relationship detection

### Phase 6: Advanced Query & Analytics 📋 PLANNED
- **Target**: April-May 2025
- **Focus**: Complex queries, effectiveness tracking, visualization

### Phase 7: Integration & Optimization 📋 PLANNED
- **Target**: May 2025
- **Focus**: Production readiness, performance optimization, deep integration

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
