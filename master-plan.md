# MemoryGraph Master Plan

**Current Version**: v0.13.0 (TypeScript/Bun CLI)
**Last Updated**: July 2026
**Test Status**: 97 tests passing, typecheck clean
**Organizing lens**: Integration readiness (can pickle-rick / an external agent adopt this?), tiered gates.

This is the single source of truth for all pending work on MemoryGraph. It is
organized as **integration-readiness gates** (Tier 0 → Tier 3): nothing integrates
in a given mode until every item in that mode's tier holds. The legacy priority
backlog (adversarial review + port-completeness) is preserved below and each item
is tagged with the gate it serves.

Status legend: ✅ done · 🟡 partial · ⛔ open · 🔎 verify (believed done, unconfirmed)

---

## 0. Ground-truth corrections to the maturity review

The review was directionally right but two Tier-0 claims were overstated. Verified
against the current tree (`ts/src/`):

- **Command injection is NOT a live vuln.** The vulnerable `safeExecSync`
  (`integration/project-analysis.ts:156`) has **zero callers** — dead code. The live
  `analyze-project` path runs through `safeGit` → `spawnSync("git", args, {cwd})`
  (`project-analysis.ts:164-172`, callers `:200,:442,:469`): array args, no shell,
  not injectable. `utils/project-detection.ts` uses static string literals with `cwd`
  passed separately. **Action shrinks to: delete dead `safeExecSync` + add a
  regression test asserting no shell-string git call path exists.**
- **Path-traversal write is low-risk.** Derived export filenames are sanitized
  (`export-import.ts:184-186`, `safeTitle` strips non-alphanumerics; YAML escaped
  `:191-193`). Only the user's own `--output` root is unconstrained — that is user
  intent, not untrusted input. Optional hardening, not a blocker.
- **C1 pagination is fixed (verified).** All three backends bind offset:
  `falkordb-shared.ts:299` (`SKIP $offset`), `bolt-shared.ts:345` (`SKIP $offset`),
  `sqlite.ts:287` (`OFFSET ?`). Export full-iterates via batched `getAllMemories`
  (`export-import.ts:235-241`); no hard 1000-cap. C1 is closed — remaining #9 scope is
  M6, M12, and the activity `LIMIT 50/20` caps only.

Net effect: **Tier 0 is materially less blocked than the review assumed.** The real
Tier-0 cost centers are runtime portability (#1) and fail-open timeouts (#4).

---

## 1. The Keystone Decision — D1: the local backend story

**Items #1, #5, #6, and #10 are one coupled decision, not four.**

- `bun:sqlite` / `Bun.file` / `Bun.sleep` hard-lock the runtime to Bun → **#1** (no
  in-process Node linking for pickle-rick).
- The only zero-native-dep backend is **sqlite**, but it `throws` on `executeQuery`
  (`sqlite.ts:147-155`), `isCypherCapable()→false`, and every intelligence /
  analytics / proactive / temporal feature is unavailable → **#10** (degrades to a
  key-value store).
- The backend that *does* real graph ops (**falkordblite**, the default) downloads a
  23.9 MB native `falkordb.so` at install (`falkordblite` postinstall → GitHub
  releases) and spawns a `redis-server` child at runtime → **#5 / #6**.

You cannot satisfy "zero-network, no-native-dep, Node-portable, *and* graph features
work" without picking a lane. Options:

| Option | #1 Node? | #5/#6 zero-dep? | #10 graph features? | Effort | Notes |
|---|---|---|---|---|---|
| **A. Harden sqlite as the local backend** | ✅ (swap `bun:sqlite`→`node:sqlite`/`better-sqlite3`) | ✅ | 🟡 emulate graph ops in-app (BFS already exists `sqlite.ts:393-459`; Cypher-subset needed) | High | Best integration fit; graph features become app-level, not Cypher. |
| **B. Pure-JS embedded graph** | ✅ | ✅ | ✅ | High + research | Find/build a no-native-dep embedded graph store. Highest risk (may not exist). |
| **C. Keep falkordblite, vendor binary + offline install** | ⛔ still native + redis subprocess; Bun-portability still needed separately | 🟡 vendored, no network but native remains | ✅ | Medium | Fails #6's "no unvendored native dep" spirit and complicates #1. |

**Recommendation: Option A.** It is the only path that lands #1, #5, #6 together and
makes #3 (frozen contract) scopable. Graph-shaped features (intelligence/analytics)
become explicitly "best-effort on the local backend, full-fidelity on a connected
Cypher backend (falkordb/memgraph)" — which is also the honest answer to Tier 3 #18
(stay complementary; don't pretend to be a full graph DB locally).

**This decision gates most of Tier 0 and all of Tier 1. Make it first.**

> **DECISION (2026-07-19): Option C chosen — see `docs/planning/D1-DECISION.md`.**
> The master plan's "Recommendation: Option A" is overridden. falkordblite stays
> the default at full graph fidelity; the native `falkordb.so` + runtime
> `redis-server` subprocess are kept but **vendored** with an **offline install**.
> De-Bun (Tier 0 #1) still happens for Node portability; the sqlite fallback's
> `bun:sqlite` moves to `node:sqlite`. Both the in-process Node module and the
> Bun-compiled binary ship.

---

## 2. Integration-Readiness Gates

### Tier 0 — Blocking prerequisites (nothing integrates in any mode until all hold)

| # | Requirement | Status | Concrete work | Refs |
|---|---|---|---|---|
| 1 | Node-portable or clean static binary | ✅ | Abstract Bun APIs: `bun:sqlite`→`node:sqlite`/`better-sqlite3`; `Bun.file`→`fs`; `Bun.sleep`→timers. Add `node` to `engines`, replace `#!/usr/bin/env bun`. Decide: in-process Node module **or** committed self-contained binary as the pinned surface. **Gated by D1.** ✅ done in M3: `bun:sqlite`→`node:sqlite` (dynamic import with `bun:sqlite` fallback for `bun test`/compiled binary, since Bun's runtime lacks `node:sqlite`); `Bun.file().json()`→`fs/promises.readFile`+`JSON.parse`; `Bun.sleep`→`setTimeout` Promise; shebang→`#!/usr/bin/env node`; Node-safe entry guard (`pathToFileURL(process.argv[1])` + `Bun.main` for the compiled binary); `index.ts` no longer auto-launches CLI on import; `engines.node`>=20; relative imports rewritten `.js`→`.ts` + tsconfig `allowImportingTsExtensions`/`verbatimModuleSyntax`/`noEmit` for Node type-stripping; `ExitError` parameter-property rewritten (Node strip-only mode rejects it). Verified: `node src/cli.ts health` Healthy; falkordblite + sqlite(node:sqlite) create/search cycles under node; `bun build` binary `health` Healthy; 218 tests green; `tsc --noEmit` clean; no `bun:*`/`Bun.*`/`import.meta.main` in ts/src/. Tests: `tests/portability.test.ts`. | `sqlite.ts:9`, `cloud.ts:280`, `export-import.ts:78`, `package.json:26-28`, `cli.ts:1` |
| 2 | Critical security findings closed | ✅ | ✅ done 2026-07-19 (M1): deleted dead `safeExecSync` (`integration/project-analysis.ts:156`); converted `utils/project-detection.ts` shell-string `execSync("git …")` calls to `spawnSync("git", args[], {cwd})` array form; added `tests/security/shell-string-git-regression.test.ts` that greps `ts/src/` and fails on any shell-string/shell-form git call. `--output` containment skipped per user. | `project-analysis.ts:156`, `utils/project-detection.ts` |
| 3 | ≥ v1.0, frozen CLI/SDK contract | ⛔ | Decide the frozen surface (finish port vs. scope-and-freeze). Cut v1.0. Semver-commit CLI commands + SDK signatures pickle-rick will pin. **Depends on D1 outcome for scope.** | `package.json:3`, `cli.ts:59`, port gaps §5 |
| 4 | Fail-open by construction | ✅ | Bounded query timeout + typed `TimeoutError` added to `BaseFalkorDBBackend.executeQuery` and `BaseBoltBackend.executeQuery` (config `QUERY_TIMEOUT` via `MEMORYGRAPH_QUERY_TIMEOUT`, default 5000ms). Never-throw SDK/integration boundary wrapper (`neverThrowBoundary` in `tools/error-handling.ts`) wraps all `handleX` exports + CLI `main()` catch + `performHealthCheck`. SEC-5: generic surfaced message + full error debug-logged. Tests: `tests/timeout-path.test.ts`, `tests/never-throw-boundary.test.ts`, `tests/never-throw-sweep.test.ts`. H8 + M13 also fixed (see §4). | `errors.ts` (TimeoutError), `config.ts` (QUERY_TIMEOUT), `tools/error-handling.ts`, `backends/falkordb-shared.ts`, `backends/bolt-shared.ts` |

### Tier 1 — Local "under-the-hood" mode

| # | Requirement | Status | Concrete work | Refs |
|---|---|---|---|---|
| 5 | Zero network at install & runtime | ⛔ | Eliminate the falkordblite postinstall binary download + runtime `redis-server` spawn from the default path. **Resolved by D1 Option A** (sqlite default) or offline-vendoring (Option C, partial). | `falkordblite` postinstall, `falkordblite.ts:51-53` |
| 6 | No unvendored native dependency | ⛔ | Remove native `.so` + redis subprocess from the default backend. **D1.** | `node_modules/falkordblite/bin/...falkordb.so` (23.9 MB) |
| 7 | Store path cwd-default + configurable | 🟡 | Add `--store`/`--db-path` CLI flag; default store to `./.memorygraph/` (working dir), not machine-global `~/.memorygraph`. Env override already exists. | `config.ts:12-14,138,188` |
| 8 | Atomic, idempotent, corruption-safe writes | 🟡 | SQLite WAL + `INSERT OR REPLACE` already good. Wrap delete (rels+memory) in one txn (`sqlite.ts:335-336` is two un-transactioned statements). Temp-file+rename+fsync for exports (`export-import.ts:63,229` write in place). | `sqlite.ts:67-68,199,334-335`, `export-import.ts:63,229` |
| 9 | Data-loss bugs fixed | 🟡 | C1 offset/pagination **fixed & verified** (`falkordb-shared.ts:299`, `bolt-shared.ts:345`, `sqlite.ts:287`). Remaining: fix M6 (relationship-direction reversal corrupts exported edges); fix/lift M12 1000-cap N+1; surface or raise activity `LIMIT 50/20` silent caps. | REDTEAM C1 (done), §4 M6/M12, `sqlite.ts:498,514` |
| 10 | pickle-rick's features work on the chosen local backend | ⛔ | Today intelligence/analytics/proactive/temporal require Cypher and throw on sqlite (H7/M7). Under D1-A: implement the used subset as app-level ops on sqlite, or explicitly scope "full fidelity requires a connected Cypher backend." | `sqlite.ts:147-155,177-185`, H7/M7 §4 |

### Tier 2 — Optional API mode

| # | Requirement | Status | Concrete work | Refs |
|---|---|---|---|---|
| 11 | Off by default, one flag, one-line local fallback | ✅ | Keep. Cloud is opt-in (`MEMORY_BACKEND=cloud` + key); auto-select falls back local-only, never *to* cloud. | `factory.ts:71-96,116-131`, `cloud.ts:124-129` |
| 12 | Exact egress manifest, surfaced before enable | ⛔ | Document the payload: `content, summary, tags, context.{project_path, files_involved, languages, frameworks, technologies, git_commit, git_branch, working_directory, additional_metadata}`. Print/consent-gate before first cloud write. | `cloud.ts:569-593,581-585` |
| 13 | Redaction controls | ⛔ | Config to exclude `content` and fs/git-derived fields before egress. None exist today (all sent verbatim). | `cloud.ts:581-591` |
| 14 | Production security posture | ⛔ | Cloud is HTTPS ✅. Add TLS option for self-hosted FalkorDB (`rediss://`; `FALKORDB_SSL` does not exist today — plaintext `falkor://` only). Verify encryption-at-rest. Replace `[DATE]` privacy-policy template with a signed, in-force policy. | `config.ts:158`, `falkordb.ts:42`, SEC-4 |
| 15 | Retention + working delete/export; docs match reality | ⛔ | Add bulk export/retention controls (only single `DELETE /memories/{id}` exists). Reconcile docs: they claim GCP residency while the live path is Cloudflare D1/KV + external FalkorDB. | `cloud.ts:437-446` |
| 16 | Network resilience with hard fail-open | 🟡 | Cloud has AbortController timeout + retry/backoff + circuit breaker ✅. Verify a 429/timeout degrades to local (or no-op) at the pickle-rick boundary rather than parking the pipeline. | `cloud.ts:29-87,171-181` |

### Tier 3 — Earns its place (value bar vs. flat markdown)

| # | Requirement | Status | Work (mostly proof/design, not code) |
|---|---|---|---|
| 17 | Named, reproducible case where markdown+grep failed | ⛔ | Produce one concrete, reproducible scenario where flat-markdown + grep was insufficient and the graph won. Burden of proof is on the tool. |
| 18 | Stays on the decision/finding axis (complementary to codegraph) | ⛔ | Scope explicitly to decisions/findings; do not overlap codegraph's code-structure graph. (D1-A's "graph features are best-effort locally" framing supports this.) |
| 19 | Integration lets pickle-rick delete something (net-neutral/negative LOC) | ⛔ | Identify the replaceable surface: `archaeology.ts` per-session markdown, or the manual "reground the ledger" grep. Subtract-before-add. |
| 20 | Observe-only in auto mode | ⛔ | Integration constraint: record/query only; never on a path that can block a Done-flip, gate, or commit. Design + enforce. |

---

## 3. Sequenced roadmap (critical path)

1. **D1 — decide the local backend story** (§1). Blocks Tier 0 #1/#3 scope and all of Tier 1 #5/#6/#10. *Do this first.*
2. **Tier 0 in parallel once D1 is set:**
   - #2 security hygiene (small — delete dead code + test).
   - #4 fail-open timeouts (medium — bounded timeout + typed error on local graph backends; wrap SDK boundary).
   - #1 runtime portability (large — execute the D1 decision: de-Bun the APIs).
   - #3 v1.0 freeze (after #1 lands and port scope is decided).
3. **Tier 1** (local mode ships): #5/#6 fall out of D1-A; then #7 store path, #8 atomic writes, #9 data-loss fixes, #10 feature parity/scoping.
4. **Tier 2** (only if API mode is pursued): #12 egress manifest → #13 redaction → #14 TLS/policy → #15 retention/docs → #16 verify fail-open. #11 already holds.
5. **Tier 3** (justification gate, can run alongside): #17 proof case, #18 scoping, #19 the delete, #20 observe-only enforcement.

**Fastest route to "integrates locally":** D1-A → #1 → #4 → #2 → (#7,#8,#9,#10). Tier 2 is optional and independent.

---

## 4. Backlog cross-reference (adversarial review) — tagged by gate

Functional bugs from the 3-agent adversarial review, each mapped to the gate it serves.

### P0 — silently non-functional features
- [ ] **H7: Temporal intelligence non-functional** *(→ Tier 1 #10)* — `intelligence/temporal.ts` reads `is_current`/`superseded_by` + `[:PREVIOUS]` chains no backend creates; `updateMemory` does in-place `SET` with no versioning. Fix: implement versioning, or disable temporal until infra exists.
- [x] ✅ **H8: FalkorDB param-passing bug breaks all parameterized Cypher on the DEFAULT backend** *(→ Tier 0 #4, discovered 2026-07-19, fixed in M2)* — `backends/falkordb-shared.ts` executeQuery now calls `this.graph.query(query, { params })` (was `query(query, params)`). Live cycle test `tests/falkordblite-live-cycle.test.ts` exercises a real store→search→recall on falkordblite with parameterized Cypher (the gap that hid the bug). Also fixed a related result-conversion bug (rows keyed by column name weren't value-flattened) and `SKIP`/`LIMIT` ordering.
- [ ] **M7: intelligence/analytics/proactive throw on SQLite & Cloud** *(→ Tier 1 #10)* — `cmdEntities --link`, `cmdPatterns`, `cmdContext`, `cmdVisualize`, `cmdSimilarity`, `cmdLearning`, `cmdGaps`, `cmdBriefing`, `cmdPredict`, `cmdWarn`, `cmdOutcome` all call `executeQuery` (throws on non-Cypher). Fix: guard with `isCypherCapable()` + clear message, or implement via CRUD.
- [ ] **M1: `recall` is identical to `search`** *(→ Tier 1 #10)* — `handleRecallMemories` calls `searchMemories` instead of `backend.recallMemories`. Fix: call `backend?.recallMemories?.()` with fallback.

### P1 — correctness degradations
- [ ] **M8: SDK vs internal cloud adapter target different APIs** *(→ Tier 2 #15)* — SDK: `api.memorygraph.dev` + Bearer + `/api/v1/memories`; internal: `graph-api.memorygraph.dev` + `X-API-Key` + `/memories`. Fix: align.
- [x] ✅ **M13: legacy `CREATE CONSTRAINT` schema init on FalkorDB v4.16.3** *(→ Tier 0 #4, discovered 2026-07-19, fixed in M2)* — schema init now uses the SDK's `graph.constraintCreate("UNIQUE", "NODE", "Memory", "id")` (the `GRAPH.CONSTRAINT CREATE` form), with a supporting `CREATE INDEX ON :Memory(id)` created first (FalkorDB requires a supporting exact-match index). Errors are no longer swallowed silently — only the "already exists" case is tolerated. Fixed in `backends/falkordb-shared.ts` initializeSchema; test `tests/falkordblite-live-cycle.test.ts` asserts no "Invalid constraint command" error.
- [ ] **M6: `getRelatedMemories` reverses relationship direction** *(→ Tier 1 #9)* — undirected traversal but always sets `from_memory_id: memoryId`. Fix: use `startNode(rel)` vs `endNode(rel)`.
- [ ] **M3: `parseSimpleArgs` can't pass values starting with `--`** *(→ Tier 0 #3 contract)* — Fix: `--` end-of-options sentinel or `--key=--value`.
- [ ] **M12: `handleWhatChanged` N+1 + implicit 1000-cap** *(→ Tier 1 #9)* — Fix: single query filtering rels by `recorded_at >= $since`.

### P1 — security
- [ ] **SEC-4: secret exposure in `config`** *(→ Tier 2 #14)* — redact URI userinfo before printing.
- [x] ✅ **SEC-5: sensitive data in error messages** *(→ Tier 0 #4, fixed in M2)* — `tools/error-handling.ts` adds `neverThrowBoundary` (outer SDK/integration wrapper above `handleToolErrors`) + `debugLogError` + `surfaceGenericError`. Surfaced message is generic (no sensitive data / raw stack); full error is debug-logged under a `[memorygraph-debug]` tag. All `handleX` tool-handler exports wrapped; CLI `main()` catch and `performHealthCheck` use `surfaceGenericError`. Tests: `tests/never-throw-boundary.test.ts` (SEC-5 generic + debug log) and `tests/never-throw-sweep.test.ts` (every CLI command with injected backend throw).
- [ ] **SEC-9: weak sensitive-data filter in context capture** *(→ Tier 2 #13)* — misses multi-word leaks, odd TLDs, base64/hex blobs, AWS keys, SSH keys.
- [ ] **SEC-10: LIKE wildcard injection in SQLite** *(→ Tier 1 #9)* — escape `%`/`_` in tag/project_path.
- [ ] **SEC-11: relationship type not validated by SQLite** *(→ Tier 0 #3)* — validate in `createRelationship` + `importFromJson`.

### P2 — low priority
- [ ] **L1** dead code in `context-extractor.ts` (redundant cast).
- [ ] **L2** dead confidence branch in `entity-extraction.ts`.
- [ ] **L3** brittle JSON `LIKE` in SQLite `project_path` filter → use `json_extract`.
- [ ] **L4** integration modules use rel types not in `RelationshipType` enum.
- [ ] **L5** `findAllCycles` throws "not yet implemented".
- [ ] **L6** `getProjectFromMemories` is a stub returning `null`.
- [ ] **M10: CLI test is vacuous** *(→ Tier 0 #3)* — tests a local reimplementation + asserts source contains `case` strings. Fix: test real command execution.

---

## 5. Not integration-blocking — port completeness & future

These are quality/parity items that do **not** gate integration. Fold in only if they
fall inside the D1 frozen-contract scope (§1); otherwise defer.

### Missing modules (Python v0.12.4 → TS)
- [ ] `relationships.py` (RelationshipManager: metadata, validation, strength, inverse, contradiction detection, type suggestion) — not ported.
- [ ] `graph_analytics.py` (GraphAnalyzer: path finding, clustering, bridge detection, metrics) — not ported.
- [ ] `advanced_tools.py` — 7 MCP tools with no CLI equivalent: `find-memory-path`, `analyze-clusters`, `bridge-memories`, `suggest-relationship`, `reinforce-relationship`, `relationship-categories`, `graph-metrics`.

### Missing backends (stubs that throw)
- [ ] **neo4j** (215-line Python impl) — would use `BaseBoltBackend`.
- [ ] **turso** (451-line libSQL impl).
- [ ] **ladybugdb** (238-line impl).

### Missing functionality
- [ ] Migration scripts: `bitemporal_migration.py`, `multitenancy_migration.py`, `migrate-to-multitenant` CLI. (Backend-to-backend migration IS ported.)
- [ ] `update_relationship_properties` — no TS backend implements post-creation rel property updates.
- [ ] `findAllCycles` — throws (only `hasCycle` ported).
- [ ] `predictSolutionEffectiveness` / `trackMemoryROI` — exported, unwired to CLI.
- [ ] SDK framework integrations (autogen, crewai, langchain, llamaindex) — TS SDK is framework-agnostic by design.

### Missing test coverage
- [ ] proactive/, integration/, analytics/, sdk/, backends/cloud.ts — no tests. (Python ~100 test files; TS has 12.)

### P3 — planned features (v0.14+ / strategic)
- [ ] Web visualization dashboard (app.memorygraph.dev) · PostgreSQL backend · embedding/semantic search · workflow templates.
- [ ] VS Code extension · GitHub Action · multi-tenancy · insights dashboard · TS framework integrations.

---

## 6. Completed in v0.13.0

~~23 adversarial review findings fixed~~ (5 Critical, 7 High, 11 Medium/Low) — see CHANGELOG.md.
~~TypeScript port from Python~~ — 303 files changed, net -63,818 lines. 35+ CLI commands, 5 working backends, 97 tests.
~~Adversarial review completed~~ — 3-agent (red-team, security, port-completeness). See `REDTEAM_FINDINGS.md`, `SECURITY_REVIEW.md`.
~~Command-injection sink neutralized~~ — live path uses `safeGit`/`spawnSync` array args; only dead `safeExecSync` remains (scheduled for deletion, Tier 0 #2).

---

## Archived Workplans

Historical Python-era workplans in `docs/planning/` and `docs/archive/` (reference-only,
mostly outdated — reference Python, MCP server, PyPI). `PRODUCT_ROADMAP.md` holds
competitive analysis and marketing strategy.
