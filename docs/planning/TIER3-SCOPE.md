# Tier 3 #18 — Scope: MemoryGraph Stays on the Decision/Finding Axis (Complementary to Codegraph)

> MemoryGraph is a graph-based memory store for **decisions and findings** — the
> "why" and "what we learned" of a project. It is explicitly NOT a code-structure
> graph. This document draws that boundary so MemoryGraph and codegraph tools
> stay complementary, with no overlap.

## The decision/finding axis

MemoryGraph's memory types (`ts/src/models.ts` `MemoryType`) and relationship
types (`RelationshipType`) were designed to capture the **decision/finding
axis** of engineering work, not the code-structure axis:

- **Decisions** are stored as `solution` (or `general`) memories: "we chose
  Option C for the backend", "we decided to vendor falkordblite", "we froze the
  CLI surface at v1.0". Each carries tags (`decision`, `backend`, ...), an
  importance weight, and a confidence score.
- **Findings** are stored as `problem` (or `error`/`fix`) memories: "Option A
  fails #6 — sqlite needs Cypher emulation", "FalkorDB v4.16.3 does not implement
  `datetime()`", "the P0 param-passing bug breaks all parameterized Cypher on the
  default backend". These are observations about the world, not structure of the
  code.
- **The relationships that connect them are decision/finding semantics**, not
  code-structure semantics: `REPLACES` (one decision supersedes another),
  `BUILDS_ON` (a decision is motivated by a finding), `CONTRADICTS` (a finding
  invalidates a decision), `SOLVES` (a solution addresses a problem),
  `ALTERNATIVE_TO`, `PREFERRED_OVER`, `DEPENDS_ON`, `EFFECTIVE_FOR`,
  `INEFFECTIVE_FOR`. See the full enum in `models.ts`.

The proof scenario in `TIER3-PROOF.md` is the canonical shape of a MemoryGraph
query: "find the decision supersession chain and the findings that motivated
each hop." That is a decision/finding traversal. It is not "find all callers of
function X" or "find the import graph" — those are codegraph questions.

## The boundary vs codegraph

A **codegraph** tool (e.g. Sourcegraph's code graph, LSIF/SCIP indexes, ctags +
call-graph extractors, tree-sitter symbol graphs) models the **structure of the
code itself**: files, modules, classes, functions, variables, import edges,
call edges, inheritance edges, type-definition edges. Its nodes are code
symbols; its edges are code-structure relationships. Its queries are "who calls
this?", "what does this import?", "where is this type defined?", "what are the
downstream callers of a refactor?"

MemoryGraph does NOT model code structure. It has no nodes for functions,
classes, or files-as-code; no edges for calls, imports, or inheritance. Its
nodes are **memories** (typed records of decisions/findings/observations) and
**entities** (extracted concepts — technologies, frameworks, project names —
mentioned in those memories). Its edges are **decision/finding semantics**
(REPLACES, BUILDS_ON, CONTRADICTS, SOLVES, ...).

| Axis             | MemoryGraph                              | Codegraph                                      |
|------------------|------------------------------------------|------------------------------------------------|
| Nodes            | Memories (decisions, findings, problems, solutions, errors, fixes), Entities (concepts mentioned) | Code symbols (functions, classes, modules, files, variables) |
| Edges            | REPLACES, BUILDS_ON, CONTRADICTS, SOLVES, DEPENDS_ON, EFFECTIVE_FOR, ... (decision/finding semantics) | CALLS, IMPORTS, INHERITS, DEFINES, REFERENCES (code-structure semantics) |
| Typical query    | "What decision is current on X, and why did it change?" | "Who calls function X?" / "What imports module Y?" |
| Source of truth  | The agent's memory store (this CLI)      | The source code on disk                         |
| Changes when     | A decision is made or a finding is recorded | The code is edited                             |
| Lifespan         | Outlives any single code revision        | Tied to a code revision / commit              |

## Complementary, no overlap

The two axes are orthogonal and complementary:

- A codegraph answers "what does the code DO?" (structure).
- MemoryGraph answers "WHY does the code do it that way?" (decisions/findings).

A refactor agent needs both: the codegraph to find the surface to change, and
MemoryGraph to find the decisions that constrained the change (so the refactor
does not silently violate a recorded decision). Neither subsumes the other.

**MemoryGraph deliberately does NOT grow into code-structure graphing.** It
will not add `CALLS` / `IMPORTS` / `INHERITS` edges, function/class nodes, or
static-analysis passes over source files. The `integration/project-analysis.ts`
module extracts PROJECT-level metadata (git remote, repo root, languages,
frameworks) as context attached to memories — it does NOT build a call graph.
The line is: project metadata that gives a memory its context is in scope;
code-structure graphing is out of scope.

## What this means for the integration (Tier 3 #20)

Because MemoryGraph stays on the decision/finding axis, its integration into an
autonomous agent pipeline is naturally observe-only (Tier 3 #20): it records
decisions/findings and answers decision/finding queries. It does NOT gate
code changes, block commits, or flip Done states — those are pipeline/codegraph
concerns. The observe-only guard (`ts/src/observe-only-guard.ts`) enforces this
at the API boundary: in auto mode, only record/query operations are permitted;
no blocking path (Done-flip, gate, commit) is reachable. See
`TIER3-PROOF.md` for the reproducible graph-wins scenario and
`master-plan.md` §2 Tier 3 for the status of #17–#20.

## See also

- `docs/planning/TIER3-PROOF.md` — the reproducible scenario where the graph
  wins on the decision/finding axis.
- `ts/src/models.ts` — the `MemoryType` and `RelationshipType` enums that
  define the decision/finding vocabulary.
- `ts/src/observe-only-guard.ts` — the auto-mode observe-only guard.
- `CONTRACT.md` — the v1.0 frozen CLI/SDK surface (all record/query, no
  codegraph operations).
