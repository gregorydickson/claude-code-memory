# D1-DECISION — Keystone Decision D1: the Local Backend Story

**Status:** ACCEPTED
**Date:** 2026-07-19
**Decision Owner:** MemoryGraph Integration-Ready Mission (orchestrator + user)
**Supersedes:** `master-plan.md` §1 "Recommendation: Option A"
**Binding for:** Tier 0 #1 (Node portability), #3 (v1.0 freeze scope), #4 (fail-open);
Tier 1 #5 (zero network), #6 (no unvendored native dep), #10 (feature parity on the
default local backend); and every milestone in the Integration-Ready mission
(M0–M7).

> **DECISION: Option C is chosen.** This document records the decision, its
> consequences, and the rationale. It overrides the master plan's prior
> "Recommendation: Option A". The master plan's §1 has been annotated with a
> pointer back to this file.

---

## 1. Context — why D1 is a single coupled decision

`master-plan.md` §1 frames four integration-readiness requirements as one coupled
decision because they cannot be satisfied independently:

- **#1 Node portability:** `bun:sqlite`, `Bun.file`, and `Bun.sleep` hard-lock the
  runtime to Bun, so pickle-rick cannot link MemoryGraph as an in-process Node
  module today.
- **#5 / #6 zero-network + no-unvendored-native-dep:** the default backend
  (`falkordblite`) downloads a 23.9 MB native `falkordb.so` at install time
  (`falkordblite` postinstall → GitHub releases) and spawns a `redis-server`
  child process at runtime.
- **#10 feature parity on the chosen local backend:** the only zero-native-dep
  backend (`sqlite`) throws on `executeQuery`, returns `isCypherCapable()→false`,
  and cannot serve intelligence / analytics / proactive / temporal features — it
  degrades to a key-value store.

You cannot satisfy "zero-network, no-native-dep, Node-portable, *and* graph
features work" simultaneously without picking a lane. The master plan enumerated
three options (A, B, C) and recommended Option A. This decision selects Option C.

| Option | #1 Node? | #5/#6 zero-dep? | #10 graph features? | Effort | Notes |
|---|---|---|---|---|---|
| A. Harden sqlite as the local backend | ✅ | ✅ | 🟡 emulate graph ops in-app | High | Was the master plan's recommendation. Graph features become app-level, not Cypher. |
| B. Pure-JS embedded graph | ✅ | ✅ | ✅ | High + research | Find/build a no-native-dep embedded graph store. Highest risk (may not exist). |
| **C. Keep falkordblite, vendor binary + offline install** ⭐ | ⛔ still native + redis subprocess; Bun-portability still needed separately | 🟡 vendored, no network but native remains | ✅ | Medium | Chosen. Fails #6's "no unvendored native dep" *letter* but satisfies its *spirit* via vendoring + offline install. |

---

## 2. The Decision — Option C

**Option C is chosen.** Concretely:

1. **`falkordblite` remains the default local backend at full graph fidelity.**
   Graph features (intelligence, analytics, proactive, temporal) are NOT emulated
   at the application level. They run as real Cypher against the embedded
   FalkorDB v4.16.3 module, exactly as they do today against a connected
   `falkordb` / `memgraph` backend.

2. **The native `falkordb.so` module and the runtime `redis-server` subprocess
   are KEPT.** They are not removed or replaced. `falkordblite` continues to load
   `falkordb.so` into a `redis-server` child process over a Unix socket per
   CLI invocation, torn down on `close()` (no fixed port, no orphans).

3. **The native binaries are VENDORED into the package with an OFFLINE
   (zero-network) install.** This is the change that turns Option C from "fails
   #5/#6" into "satisfies #5 and #6 in spirit":
   - `falkordb.so` for `darwin-arm64` and `linux-x64` is committed under
     `ts/vendor/falkordblite/<platform>/`.
   - A compatible `redis-server` binary for each platform is committed alongside
     it (`darwin-arm64` uses Homebrew Redis 8.8.0, proven compatible; `linux-x64`
     uses Redis 8.2.3 extracted from the `falkordb/falkordb:v4.16.3` Docker image,
     an exact match).
   - The install path copies the binaries from the vendored location into the
     package's bin directory. **No postinstall step fetches from the network.**
     The current `falkordblite` postinstall GitHub-release download is removed
     or replaced with a local copy.
   - End-user installs work with network blocked (Tier 1 #5).

4. **De-Bun (Tier 0 #1) still happens, and is independent of the backend
   choice.** All Bun-specific APIs in `ts/src/` are abstracted to Node-equivalent
   APIs so the project runs under `node` (v24+) and ships as an in-process Node
   module — the primary integration surface for pickle-rick.

5. **The sqlite fallback's `bun:sqlite` import moves to `node:sqlite`** (built-in
   on Node v24, no new dependency). The sqlite backend stays a non-Cypher opt-out
   fallback (`isCypherCapable()→false`); it is NOT promoted to the default. It
   prints clear "unsupported on sqlite fallback / Cypher-capable backend
   required" messages for features it cannot serve, never throws.

6. **Both surfaces ship:**
   - the **in-process Node module** (primary integration surface for
     pickle-rick), imported as a library without launching the CLI; AND
   - the **Bun-compiled static binary** (`bun build src/cli.ts --compile
     --outfile memorygraph`) as a convenience artifact for users who want a
     single-file executable. Bun remains the test runner and the compiled-binary
     build tool; it is no longer required to *run* the CLI.

---

## 3. Consequences

### 3.1 What this decision ENABLES

- **Tier 1 #5 (zero network at install AND runtime):** satisfied by vendoring the
  native binaries and removing the postinstall download. Verified by a clean
  install with network blocked (M5 gate).
- **Tier 1 #6 (no unvendored native dep, in spirit):** satisfied by committing
  the `.so` and `redis-server` into the repo/package. The *letter* of #6 ("no
  native dep") is not met — the native module remains — but the *spirit* ("no
  external/native dependency that the user must fetch, build, or trust the
  network for") is met. This is the explicit trade-off the user accepted in
  pre-deciding Option C.
- **Tier 1 #10 (feature parity on the default backend):** satisfied for free.
  Because `falkordblite` is a real Cypher backend, every intelligence / analytics
  / proactive / temporal feature works on the default local backend at full
  fidelity — no app-level graph emulation is required. (Subject to fixing the
  two discovered bugs H8 and M13; see §3.3.)
- **Tier 0 #1 (Node portability):** satisfied by De-Bun (M3). The default backend
  runs under `node` once `bun:*` imports are removed from `ts/src/`. The native
  `falkordb.so` is loaded via the same `node-ffi`-style mechanism `falkordblite`
  already uses; Node compatibility is preserved.
- **Tier 0 #3 (v1.0 freeze scope):** the frozen CLI/SDK surface (M4 `CONTRACT.md`)
  is scoped against the *current* Cypher-backed feature set, not a hypothetical
  app-level emulation layer. This makes the contract smaller and more honest.

### 3.2 What this decision DOES NOT do

- **Does NOT remove the native dependency.** `falkordb.so` and `redis-server`
  remain. End-users get them from the vendored copy, not from the network, but
  the native surface is still there. Platforms outside `darwin-arm64` and
  `linux-x64` are not supported by the vendored binaries (documented limitation).
- **Does NOT make sqlite the default.** sqlite stays an opt-out fallback
  (`MEMORY_BACKEND=sqlite`) for environments that cannot load the native module.
  Its CRUD works; its Cypher-requiring features print clear unsupported messages.
- **Does NOT promote sqlite to a full graph backend.** The BFS traversal that
  exists in `sqlite.ts` is not extended into a Cypher-subset emulator. Option A's
  "emulate graph ops in-app" work is explicitly NOT done.
- **Does NOT change Tier 2 (cloud/API mode).** Cloud code paths remain out of
  scope for this mission except the single De-Bun edit (`Bun.sleep`→`setTimeout`
  in `cloud.ts:280`) required by Tier 0 #1.

### 3.3 Discovered bugs that MUST be fixed for Option C to hold

Readiness testing revealed the master plan's premise that `falkordblite` "works"
is currently **false** due to two latent bugs no test exercises. Both are
recorded in `master-plan.md` §4 and are fixed as the first tasks of M2, before
M3's gate requires a live create/search cycle under Node:

- **H8 (P0):** `backends/falkordb-shared.ts:99` calls
  `this.graph.query(query, params)` but the `falkordb-ts` driver reads
  `options.params`, so `params` is always `undefined` and every parameterized
  Cypher query (`store`/`search`/`recall`/`update`/etc.) fails on `falkordblite`
  AND `falkordb` with "Missing parameters" / "expected STARTS WITH, SET or
  START". Fix: `this.graph.query(query, { params })`. **This bug blocks the
  entire D1-Option-C premise.**
- **M13 (P1):** schema init uses legacy `CREATE CONSTRAINT` Cypher; FalkorDB
  v4.16.3 requires the `GRAPH.CONSTRAINT` command. The error is currently
  swallowed, so constraints are silently never created. Fix: use
  `GRAPH.CONSTRAINT` syntax.

Until H8 is fixed, the default backend cannot serve any parameterized Cypher.
M2 closes both bugs and adds the live `store→search→recall` integration test
that would have caught H8.

### 3.4 Trade-offs accepted

- **Native surface remains.** We accept the cost of vendoring ~50 MB of native
  binaries per platform (darwin-arm64 + linux-x64) in exchange for full graph
  fidelity on the default local backend with zero network at install/runtime.
- **Two-platform vendoring.** Only `darwin-arm64` and `linux-x64` are vendored.
  Other platforms (e.g. `linux-arm64`, `darwin-x64`) would need their own
  vendored binaries or fall back to sqlite. Documented, not solved in this
  mission.
- **dylib expectations on darwin.** The vendored darwin-arm64 `redis-server`
  depends on `libomp.dylib` and openssl@3 dylibs from Homebrew. M5 documents the
  dylib expectation; it does not bundle Homebrew itself. (The `falkordb.so`
  module has the same dylib expectations today.)
- **Bun still required for the compiled binary.** The Bun-compiled static binary
  is a convenience artifact; producing it requires Bun. Running the CLI as a
  Node module or via `node src/cli.ts` does NOT require Bun.

---

## 4. Milestone impact (what each milestone does under Option C)

- **M0 (this doc):** record the decision; annotate `master-plan.md` §1.
- **M1 (Tier 0 #2):** delete dead `safeExecSync`; add the shell-string git
  regression test. Unchanged by Option C.
- **M2 (Tier 0 #4 + H8 + M13):** fix H8 (`{ params }`) and M13
  (`GRAPH.CONSTRAINT`); add bounded query timeout + `TimeoutError`; wrap the
  SDK/integration boundary so no backend throw escapes to pickle-rick; SEC-5
  generic surfaced error + full debug log. H8/M13 fixes are *required* by Option
  C — without them `falkordblite` is non-functional.
- **M3 (Tier 0 #1 — De-Bun):** `bun:sqlite`→`node:sqlite`; `Bun.file`→`fs/promises`;
  `Bun.sleep`→`setTimeout`; `import.meta.main`→Node-safe entry guard;
  `#!/usr/bin/env bun`→`#!/usr/bin/env node`; remove the unconditional `main()`
  call in `index.ts`; add `node` to `engines`. Verify the default `falkordblite`
  backend runs a create/search cycle under `node` and the Bun-compiled binary
  still builds.
- **M4 (Tier 0 #3 — v1.0 freeze):** `CONTRACT.md` at repo root documenting the
  frozen CLI command set + SDK method signatures; `package.json` → `1.0.0`;
  `parseSimpleArgs` `--`/`--key=--value`; SEC-11 sqlite rel-type validation;
  M10 real CLI execution tests.
- **M5 (Tier 1 #5–#10):** vendor `falkordb.so` + `redis-server` for both
  platforms; rewrite install path to copy from the vendored location with NO
  network download; `--store`/`--db-path` flag with `./.memorygraph/` default;
  atomic writes (single-txn delete, temp+rename+fsync exports); data-loss fixes
  (M6 rel direction, M12 single-query `handleWhatChanged`, activity cap
  surfacing, SEC-10 LIKE escape); feature-parity verification on the default
  `falkordblite` backend (H7 temporal, M7 intelligence/analytics/proactive,
  M1-backlog `recall`≠`search`); sqlite-fallback `isCypherCapable()` guards with
  clear unsupported messages; full CLI command sweep.
- **M6 (Tier 3 #17–#20):** `TIER3-PROOF.md`, `TIER3-SCOPE.md`, subtract-before-add
  demonstration, observe-only-in-auto-mode guard.
- **M7 (P2 cleanup L1–L6 + final verification):** L1–L6 cleanup; final gate
  (full `bun test` + `tsc` + `bun build` + `node` run + compiled-binary smoke
  test on default `falkordblite` with NO network); `master-plan.md` status column
  updated for every closed item; cross-check that this doc, `CONTRACT.md`,
  `TIER3-PROOF.md`, `TIER3-SCOPE.md` are consistent with the code.

---

## 5. Why not Option A (the master plan's prior recommendation)?

Option A (harden sqlite as the default local backend, emulate graph ops in-app)
was the master plan's recommendation because it is the only path that lands #1,
#5, #6 *together by the letter* and makes #3 scopable. The user overrode it in
favor of Option C for these reasons:

1. **Full graph fidelity locally is the value proposition.** MemoryGraph's
   intelligence/analytics/proactive/temporal features are written as Cypher
   against a real graph engine. Emulating them in-app on sqlite (Option A) is
   High effort AND produces a strictly weaker local backend — best-effort, not
   full-fidelity. Tier 3 #18 ("stay complementary to codegraph, on the
   decision/finding axis") is better served by a real graph backend than by an
   app-level emulator that approximates one.
2. **Vendoring closes the practical gap.** The objection to Option C in the
   master plan was "#5/#6 fail: native dep + network download." Vendoring the
   `.so` and `redis-server` into the package with an offline install closes the
   *practical* gap (no network at install or runtime, no user-fetchable native
   dep) at the cost of accepting a native surface inside the package. The user
   judged that trade-off as worth full graph fidelity.
3. **Lower risk than Option B.** Option B (find/build a pure-JS embedded graph
   store with Cypher-class capability) is High effort plus research risk — such
   a store may not exist or may not be production-quality. Option C uses the
   already-working, already-tested `falkordblite` backend.
4. **De-Bun is independent.** Tier 0 #1 (Node portability) is satisfiable
   regardless of the backend choice. Option C does not block De-Bun; it just
   means De-Bun produces a Node module that loads the vendored native `falkordb.so`
   instead of a Node module that talks to an in-app sqlite graph emulator.

---

## 6. Invariants this decision imposes on the mission

1. **`falkordblite` is and remains the default backend.** No feature in this
   mission changes the default. `MEMORY_BACKEND=sqlite` remains an opt-out.
2. **No new npm dependencies.** `node:sqlite` is built-in on Node v24, not a new
   dep. `better-sqlite3` is FORBIDDEN (contradicts the de-native-deps spirit of
   the sqlite fallback; the user chose `node:sqlite`).
3. **Zero network at install AND default runtime** (from M5 onward). The
   vendored binaries are the only source for the native module and
   `redis-server`. No postinstall fetch.
4. **Both surfaces ship.** The in-process Node module (primary) and the
   Bun-compiled binary (convenience). Neither is dropped.
5. **Graph features are NOT emulated at the app level on the default backend.**
   They run as Cypher against `falkordblite`. Sqlite prints clear unsupported
   messages for features it cannot serve; it does not throw.
6. **Tier 2 (cloud/API mode) is out of scope** except the single De-Bun edit
   (`Bun.sleep`→`setTimeout` in `cloud.ts:280`). This decision does not change
   cloud behavior.

---

## 7. Cross-references

- `master-plan.md` §1 — annotated with "Option C chosen — see
  `docs/planning/D1-DECISION.md`", overriding the prior "Recommendation: Option
  A".
- `master-plan.md` §4 — records H8 (param bug, P0) and M13 (constraint syntax,
  P1), the two discovered bugs that must be fixed in M2 for Option C to hold.
- `architecture.md` — "D1 Decision: Option C (pre-decided by the user)" section
  documents the architectural consequences.
- `AGENTS.md` — Mission Boundaries and Dependencies reflect Option C
  (`falkordblite` kept, `node:sqlite` for the fallback, no new deps, zero network
  at install/runtime).
- Validation contract assertions `VAL-D1-001`, `VAL-D1-002`, `VAL-D1-003` define
  the gate for this decision.
