# AGENTS.md

MemoryGraph is a TypeScript/Bun CLI for graph-based memory storage, used by AI
coding agents for persistent cross-session memory.

## Master Plan & Contract (read before changing the CLI surface)

- `master-plan.md` (repo root) — single source of truth for pending work,
  tiered integration-readiness gates, and port-completeness gaps.
- `CONTRACT.md` (repo root) — **public contract** (enumerated at the current
  release): the 34-command CLI surface and the SDK exports of
  `ts/src/index.ts` / `ts/src/sdk/index.ts`. Check it before renaming
  commands, flags, or exports. Argument-parsing semantics of
  `parseSimpleArgs` (`--`, `--key=--value`, value-escape rules) are part of
  the contract.

## Setup

```bash
cd ts && bun install
```

The `postinstall` script (`scripts/vendor-postinstall.cjs`) copies
**vendored** falkordblite native binaries from `ts/vendor/falkordblite/` into
`node_modules/` — installs never touch the network. If a platform binary is
missing it warns and exits 0 (install still succeeds; use `--backend sqlite`).

## Development

```bash
cd ts
bun test             # full suite: 431 tests, ~40s
npx tsc --noEmit     # typecheck (strict mode)
bun run src/cli.ts <command>   # run CLI directly
bun build src/cli.ts --compile --outfile memorygraph   # compile standalone binary
```

There is no ESLint; `tsc --noEmit` is the only static check. Some tests are
source-level "grep" tests that assert invariants over `ts/src/` (e.g.
`tests/security/shell-string-git-regression.test.ts`,
`tests/bottom-catch-never-throw.test.ts`) — refactoring can break them even
when behavior is unchanged.

## Project Layout

```
ts/src/
  cli.ts              # CLI entry point (34 commands, ~1700 lines)
  index.ts            # library barrel exports (part of frozen SDK surface)
  config.ts           # env-based config, static getters read process.env at call time
  database.ts         # IMemoryDatabase interface + MemoryDatabase/CloudMemoryDatabase
  models.ts           # Zod schemas: Memory, Relationship, SearchQuery
  errors.ts           # MemoryError subtypes
  observe-only-guard.ts  # auto-mode guard (see below)
  backends/           # GraphBackend implementations + factory.ts dispatch
  tools/              # CLI tool handlers (handleToolErrors wrapper)
  intelligence/       # entity extraction, pattern recognition, context retrieval
  analytics/          # graph visualization, similarity, learning paths
  proactive/          # session briefing, predictions, outcome tracking
  integration/        # context capture, project analysis, workflow tracking
  migration/          # backend-to-backend migration with verification
  sdk/                # cloud API client
  utils/              # export/import, validation, pagination, helpers
ts/tests/             # test files
ts/vendor/falkordblite/  # committed native binaries (darwin-arm64, linux-x64)
```

## Key Patterns

- **Backends** implement `GraphBackend` (`backends/base.ts`). Cypher backends
  share query logic via `BaseFalkorDBBackend` (FalkorDB/FalkorDBLite) and
  `BaseBoltBackend` (Memgraph/Neo4j Bolt); SQLite has its own implementation.
  Backend status: falkordblite (default), sqlite, falkordb, memgraph, cloud all
  working; neo4j/turso/ladybugdb are stubs that throw.
- **Intelligence/analytics/proactive/integration modules take `GraphBackend`
  as first arg, not `IMemoryDatabase`**, and require a Cypher-capable backend.
- **Tool handlers** use `handleToolErrors` (tools/error-handling.ts) and
  return `{ isError, text }`.
- **Error handling is two-layered by design (SEC-5)**:
  `handleToolErrors` catches known MemoryError subtypes and re-throws
  unexpected ones; `neverThrowBoundary` (SDK boundary) and
  `surfaceGenericError` (CLI top-level catch) guarantee nothing throws and no
  stack/secrets reach the surfaced message — full errors go to stderr
  prefixed `[memorygraph-debug]`. Tests enforce this; don't add a path that
  surfaces raw errors.
- **Observe-only guard** (`observe-only-guard.ts`): when `MEMORYGRAPH_AUTO_MODE`
  is set, MemoryGraph must never be able to block an agent pipeline.
  `assertAutoModeSafe(op)` is the enforcement point; a test sweeps the whole
  CLI surface for violations. New commands must stay observe-only.
- **CLI arg parsing** uses `parseSimpleArgs`, not `node:util` `parseArgs`.
  Config is read via static getters on `Config`; CLI flags override by setting
  `process.env` before first getter call.

## Gotchas

- **Default store is `./.memorygraph/` (cwd-relative), NOT `~/.memorygraph/`**
  — each working directory gets an isolated graph. The README's `~/.memorygraph`
  mention predates this change. Override with `MEMORY_STORE_PATH` (also set by
  the `--store` / `--db-path` CLI flags). Note: store/backend env vars use the
  `MEMORY_*` prefix; cloud/API settings use `MEMORYGRAPH_*`.
- `falkordblite` is the default backend and spawns a real redis-server from
  the vendored tree; the sqlite backend (`--backend sqlite`) is the fallback
  when no native binary matches your platform.
- Env config vars are `MEMORYGRAPH_*` (`MEMORYGRAPH_API_URL`,
  `MEMORYGRAPH_API_KEY`, `MEMORYGRAPH_TIMEOUT`, `MEMORYGRAPH_QUERY_TIMEOUT`,
  ...). Profile flag: `--profile core|extended` (legacy aliases `lite`→core,
  `standard`/`full`→extended).
- `docs/archive/` and `docs/planning/` are historical; `master-plan.md` and
  `CONTRACT.md` at the root are current.
- Historical adversarial reviews live in `REDTEAM_FINDINGS.md` /
  `SECURITY_REVIEW.md`; several findings there are already fixed — verify
  against `master-plan.md` section 0 ("Ground-truth corrections") before
  re-fixing anything.

## Releases & Versioning

**Scheme (0.x):** the project is pre-1.0 on purpose. Within a patch line
(e.g. `0.14.x`) the contract surfaces stay stable; breaking changes go in a
minor bump (`0.15.0+`) and MUST be called out in `CHANGELOG.md`. **v1.0 is a
big gate** — only bump to 1.0.0 when the product is fully built out
(master-plan gaps closed, `sdk/` and `backends/cloud.ts` under test, cloud
tier validated). A premature 1.0 freeze was rolled back on 2026-08-27;
don't repeat it casually.

**The version string lives in six places** — all must move together:
1. `ts/package.json` (`version`)
2. `ts/src/index.ts` (`export const VERSION`)
3. `ts/src/cli.ts` (`const VERSION` — drives `--version` output)
4. `ts/tests/cli-commands.test.ts` (two expectations)
5. `ts/tests/m5-cli-command-sweep.test.ts` (one expectation)
6. Version references in `CONTRACT.md` + the `CHANGELOG.md` section header

**Release procedure** (suite green, typecheck clean first):
```bash
# after committing the version bump:
git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary>"
git push origin main && git push origin vX.Y.Z
gh release create vX.Y.Z --title "MemoryGraph vX.Y.Z — <name>" --notes "..."
```

**Re-versioning a published release** (done twice on 2026-08-27): delete the
GitHub release (`gh release delete vX.Y.Z --yes`), delete the tag locally
and remotely (`git tag -d`, `git push origin :refs/tags/vX.Y.Z`), commit the
new version, re-tag, re-release. Tags must never be reused or moved.

## Adding a New Backend

1. Create `ts/src/backends/<name>.ts`
2. Extend `BaseFalkorDBBackend` (Cypher) or `BaseBoltBackend` (Bolt) or
   implement `GraphBackend` directly
3. Add to `factory.ts` dispatch, `backends/index.ts` exports, and the
   `BackendType` union in `config.ts`
4. Add config getters to `config.ts` if needed
