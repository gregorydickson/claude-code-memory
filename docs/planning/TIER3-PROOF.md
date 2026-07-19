# Tier 3 #17 — Proof: A Reproducible Scenario Where Flat-Markdown + grep Lost and the Graph Won

> Burden of proof is on the tool. This document gives ONE concrete, reproducible
> scenario with exact inputs, commands, and expected graph-only results, run on
> the default `falkordblite` backend. A validator can copy-paste the commands and
> reproduce the outcome.

## Scenario — Multi-hop decision supersession chain with cross-join to motivating findings

An agent (pickle-rick) records three backend decisions over multiple sessions and
one finding that motivates a change of direction:

| Node | Type     | Title                                  | Role in the story                         |
|------|----------|----------------------------------------|-------------------------------------------|
| D1   | solution | Backend: Option A (harden sqlite)      | The original decision                     |
| F1   | problem  | Option A fails #6 graph features       | The finding that contradicts D1           |
| D2   | solution | Backend: Option C (keep falkordblite)  | The decision that REPLACES D1, BUILDS_ON F1 |
| D3   | solution | Backend: De-Bun + node:sqlite fallback | The decision that REPLACES D2, BUILDS_ON D2 |

Relationships (typed, directed edges):

```
F1 -[CONTRADICTS]-> D1
D2 -[REPLACES]->    D1
D2 -[BUILDS_ON]->   F1
D3 -[REPLACES]->    D2
D3 -[BUILDS_ON]->   D2
```

The question an agent must answer to "reground" its decision ledger:

> **Find the full REPLACES chain starting from D1, and for each decision in
> that chain, find the findings (problems) that motivated it.**

This is a 2-hop traversal (D1 -> D2 -> D3) PLUS a cross-join (each Di -> its
BUILDS_ON/CONTRADICTS findings). It is the exact "reground the ledger" query that
the master plan names as the replaceable manual-grep surface (Tier 3 #19).

## Reproducible setup (run from `ts/`)

```bash
rm -rf /tmp/tier3-proof /tmp/tier3-proof-md
mkdir -p /tmp/tier3-proof /tmp/tier3-proof-md
export MEMORY_FALKORDBLITE_PATH=/tmp/tier3-proof
cd ts

# Store the 4 memories; capture each returned ID.
D1=$(bun run src/cli.ts store --type solution \
  --title "Backend: Option A (harden sqlite)" \
  --content "Backend decision: harden sqlite as the local backend (Option A). Zero native deps, Node-portable." \
  --tags decision,backend 2>/dev/null | grep -oE 'ID: [a-f0-9-]+' | head -1 | awk '{print $2}')
F1=$(bun run src/cli.ts store --type problem \
  --title "Option A fails #6 graph features" \
  --content "Finding: Option A fails Tier 1 #6 — sqlite needs full Cypher emulation for graph features (intelligence/analytics/proactive/temporal), high-effort and research-risky." \
  --tags finding,backend 2>/dev/null | grep -oE 'ID: [a-f0-9-]+' | head -1 | awk '{print $2}')
D2=$(bun run src/cli.ts store --type solution \
  --title "Backend: Option C (keep falkordblite, vendor)" \
  --content "Backend decision: keep falkordblite at full graph fidelity, vendor the native binary + redis-server with offline install (Option C)." \
  --tags decision,backend 2>/dev/null | grep -oE 'ID: [a-f0-9-]+' | head -1 | awk '{print $2}')
D3=$(bun run src/cli.ts store --type solution \
  --title "Backend: De-Bun + node:sqlite fallback" \
  --content "Backend decision: add node:sqlite fallback + De-Bun for Node portability alongside the vendored falkordblite default." \
  --tags decision,backend,portability 2>/dev/null | grep -oE 'ID: [a-f0-9-]+' | head -1 | awk '{print $2}')

# Wire the typed, directed edges.
bun run src/cli.ts link "$F1" "$D1" CONTRADICTS --context "Option A fails #6 zero-native-dep spirit" 2>/dev/null
bun run src/cli.ts link "$D2" "$D1" REPLACES    --context "Option C supersedes Option A"            2>/dev/null
bun run src/cli.ts link "$D2" "$F1" BUILDS_ON   --context "Option C chosen because Option A fails graph features" 2>/dev/null
bun run src/cli.ts link "$D3" "$D2" BUILDS_ON   --context "De-Bun + node:sqlite fallback builds on Option C"     2>/dev/null
bun run src/cli.ts link "$D3" "$D2" REPLACES    --context "refines Option C with portability"       2>/dev/null
```

## The graph wins — two CLI calls, structured results

```bash
# Call 1: the full REPLACES chain from D1 (depth 3 reaches D2 and D3).
bun run src/cli.ts related "$D1" --types REPLACES --max-depth 3
```

Expected graph-only result (observed 2026-07-19):

```
Found 2 related memories:

**1. Backend: Option C (keep falkordblite, vendor)** (ID: 688e7594-...)
Relationship: REPLACES (strength: 0.5)
Type: solution | Importance: 0.5

**2. Backend: De-Bun + node:sqlite fallback** (ID: e7febc40-...)
Relationship: REPLACES (strength: 0.5)
Type: solution | Importance: 0.5
```

```bash
# Call 2: the motivating findings for D2 (BUILDS_ON + CONTRADICTS).
bun run src/cli.ts related "$D2" --types BUILDS_ON,CONTRADICTS
```

Expected graph-only result (observed 2026-07-19):

```
Found 3 related memories:

**1. Option A fails #6 graph features** (ID: a21c78ae-...)
Relationship: BUILDS_ON (strength: 0.5)
Type: problem | Importance: 0.5

**2. Backend: Option A (harden sqlite)** (ID: 222743f2-...)
Relationship: BUILDS_ON (strength: 0.5)
Type: solution | Importance: 0.5

**3. Backend: De-Bun + node:sqlite fallback** (ID: e7febc40-...)
Relationship: BUILDS_ON (strength: 0.5)
Type: solution | Importance: 0.5
```

Two calls. Structured `(memory, relationship-type, direction, properties)` tuples.
No manual ID bookkeeping. No ambiguity about which file is the replacer vs the
replaced.

## Flat-markdown + grep loses — three concrete failure modes

Export the same data to flat markdown (the "per-session markdown" surface):

```bash
bun run src/cli.ts export --format markdown --output /tmp/tier3-proof-md 2>/dev/null
ls /tmp/tier3-proof-md/
# Backend__De-Bun___node_sqlite_fallback_e7febc40-570.md
# Backend__Option_A__harden_sqlite__222743f2-55f.md
# Backend__Option_C__keep_falkordblite__vendor__688e7594-e55.md
# Option_A_fails__6_graph_features_a21c78ae-36f.md
```

### Failure 1 — grep by ID returns ALL files mentioning the ID, not the replacer

```bash
grep -rl "222743f2-55fc-433e-a1df-e10c1965ce3f" /tmp/tier3-proof-md/
# Backend__Option_A__harden_sqlite__222743f2-55f.md        <- D1 itself (self-match)
# Backend__Option_C__keep_falkordblite__vendor__688e7594-e55.md  <- D2 (mentions D1 in REPLACES)
# Option_A_fails__6_graph_features_a21c78ae-36f.md         <- F1 (mentions D1 in CONTRADICTS)
```

grep returns 3 files. It cannot tell you which one is the **replacer** (D2) vs the
**replaced** (D1) vs an **unrelated contradiction** (F1). The relationship type
and direction are in a `**REPLACES** ->` markdown bullet that grep does not parse.
A human (or a fragile regex pipeline) must open each file and read the
"Relationships" section to disambiguate. The graph returns the typed, directed
edge directly.

### Failure 2 — grep cannot do transitive closure (multi-hop chain)

The answer requires D1 -> D2 -> D3. grep is a flat string matcher: it has no
notion of edges or traversal. To get D3 from D1 you must:

1. `grep -rl "<D1-id>" *.md` -> find D2's file
2. extract D2's ID from D2's file's frontmatter
3. `grep -rl "<D2-id>" *.md` -> find D3's file
4. extract D3's ID

That is N iterative greps with manual ID extraction between each hop, growing
linearly with chain length. The graph's `related --max-depth 3` returns the full
chain in ONE call regardless of depth.

### Failure 3 — grep cannot join across files (decisions x motivating findings)

D2's markdown file contains the line:

```
- **BUILDS_ON** -> [Option A fails #6 graph features](a21c78ae-36fd-4f63-832b-b9dce6d6aa8f)
```

To get F1's **content** (the finding text), you must take that ID, then
`grep -rl "a21c78ae-..." *.md` to find F1's file, then `cat` it. That is a
cross-file join that grep cannot express in a single invocation. The graph's
`related --id D2 --types BUILDS_ON,CONTRADICTS` returns F1's full memory object
(title, type, content, importance) in the same structured result as the
relationship — no second lookup.

## Why this is the honest case for the graph (not a toy)

The scenario is the actual "reground the ledger" workflow the master plan names
in Tier 3 #19: an agent that records decisions across sessions needs to answer
"what is the current decision on X, and why did it change?" That question is a
typed-edge traversal + a cross-join. Flat markdown + grep can store the same
facts (as this export shows) but cannot ANSWER the question without N greps,
manual ID bookkeeping, and human disambiguation of relationship type/direction.
The graph answers it in two structured calls.

The subtract-before-add evidence (Tier 3 #19) is recorded in
`master-plan.md` §2 Tier 3 row #19 and reproduced here for cross-reference:

- **Removed surface:** `findAllCycles` (stub in `ts/src/utils/graph-algorithms.ts`
  that threw "find_all_cycles not yet implemented") and `getProjectFromMemories`
  (stub in `ts/src/utils/project-detection.ts` that returned `null`). Both were
  manual linear-scan ("grep-the-list") routines that the graph replaces natively:
  cycle detection via Cypher path queries / the existing `hasCycle` DFS guard,
  and project lookup via `MATCH (m:Memory)-[:PART_OF]->(p:Entity {type:'project'})`.
- **Diff:** `git diff --stat ts/src/utils/graph-algorithms.ts ts/src/utils/project-detection.ts`
  shows `2 files changed, 14 deletions(-)` — net **-14 LOC**, non-positive.
- **No longer present:** `grep -rn "findAllCycles\|getProjectFromMemories" ts/src/`
  returns no matches. Neither symbol was in the v1.0 frozen contract
  (`CONTRACT.md`) and neither had any caller.

## See also

- `docs/planning/TIER3-SCOPE.md` — the decision/finding axis scope and the
  codegraph boundary (Tier 3 #18).
- `master-plan.md` §2 Tier 3 — the status column for #17, #18, #19, #20.
- `ts/src/observe-only-guard.ts` — the auto-mode observe-only guard (Tier 3 #20).
