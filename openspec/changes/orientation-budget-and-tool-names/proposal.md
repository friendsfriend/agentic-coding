## Why

Agents spend their most expensive turns orienting instead of writing, and the
prompts hide the shape of that cost from them. In the measured corpus (all
figures restated against the repaired denominator **441.9321**; older documents
use 391.0161), `core.plan` spends **8.2161 of its 16.1897 units (50.7 %)** before
its first artifact and writes first at turn 19.7, while the wiki step spends
**66 %** (1.2833 of 1.9434) with its first write at turn 53.3 and seven of twelve
runs spending ≥95 % of their calls before writing. The five fully-evidenced
worker runs spend **44 % of calls and 67 % of result bytes** before their first
edit (360/820 calls, 1,258/1,882 KB), and in one run 33 of 39 `read`/`grep`
targets were not among the files it edited — the effort is aimed by hand at code
the plan already names. At the same time the shell carries work a dedicated tool
already covers, and only the 17.6 kB protocol document says so: planners made
**0 `grep` calls** in the whole slice (1,621 `bash` vs 908 `read`), the wiki step
made 431 of 718 calls through the shell carrying 1.36 MB of its 1.79 MB, and
`bash-vs-tools` ranges 3.2 %–79.2 % per run — entirely model-dependent (every
`deepseek-flash` run made 0 `grep` calls, the `luna` run made 38).

Nothing here needs engine machinery: what is missing is that no brief states a
budget, no assignment repeats what tool reads code, and the assignment refuses
to hand an agent the scope the engine already knows.

## What Changes

- **(a) An exploratory budget and a skeleton-first rule** in the planning brief
  and both wiki briefs: create the change directory / first concept early and
  extend it in place, bound exploration to the change's own surface, and keep
  what cannot be settled out of the reading loop (plan questions instead). The
  budget bounds exploration, not the required reads — every dependency artifact
  is still read from disk before the next one is written.
- **(b) The plan's file list reaches the implementation assignment.**
  `core.implementation` runs get a `Plan files:` input rendered from the recorded
  plan artifact's declared file paths, and the planning brief states that the
  plan artifact declares that list. When the plan declares none, the assignment
  renders no list rather than guessing or inlining change documents.
- **(c) A verification assignment carries the round's scope.** Every
  `core.verification` run lists the round's changed files (the engine's
  changed-file set, bounded) and, from round 2 on, the most recent recorded
  findings per verifier role as bounded `severity path:line — detail` lines.
  Round 1 renders no prior-findings section. Which roles re-run is **not**
  changed here (backlog item 15 owns role scoping).
- **The tool surface is stated where it is read.** The rendered assignment names
  `read`/`grep`/`bash` in its first lines — `read` with `offset`/`limit` and
  `grep` with a `path` filter are the default way to inspect code, `bash` is for
  builds, tests and `openspec` — names `codemode` only when the run offers it,
  and repeats the batching rule (independent calls in one message, not one call
  per turn). The `read`, `grep`, `bash` and `codemode` descriptions carry the
  same rule where the agent selects a tool.
- **Measured, budgeted prompt growth.** The fixed net addition is 399 B per
  assignment (the tool block) plus 491 B in the planning brief and 327 B in each
  wiki brief; forwarded lists are bounded (40 plan paths, 100 changed files,
  4 KiB of prior-finding text). Per-role numbers are recorded in `design.md`.
- **No new state.** No snapshot schema change (`STORE_SCHEMA_VERSION` stays 6),
  no new effect, step, edge, transition, migration or compatibility shim, no
  migration path; the forwarded data is read from state the engine already holds
  (`snapshot.evidence` paths and the recorded plan artifact). No role gains or
  loses a tool.
- **One additive efficiency query** for the measure the verification plan needs
  and that no query answers: per-run tool mix by profile including `grep` calls
  and the median result bytes per exploratory call. Existing queries and the CSV
  number format are untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-agent-assignment`: the assignment envelope states the run's tool
  surface and batching rule; an implementation assignment carries the plan's file
  list; a verification assignment carries the round's changed files and prior
  recorded findings.
- `durable-agent-tools`: the `read`, `grep`, `bash` and `codemode` descriptions
  state the inspection default, the shell's purpose and the batching rule, and
  name `codemode` only when the run's tool set contains it.
- `planner-change-authoring`: the planning brief states an exploratory budget and
  the skeleton-first rule, and the plan artifact declares the plan's file list.
- `knowledge-wiki`: both wiki briefs state a write-early budget and a bounded
  orientation rule.

## Impact

- `agent-definitions/instructions/planning.md`, `wiki-openspec.md`,
  `wiki-research.md` and their regenerated pin in
  `src/workflow/embedded.generated.ts`.
- `src/workflow/assignment.ts` (the tool-surface block and the forwarded input
  lines), `src/workflow/runtime/` (a bounded reader for the recorded plan
  artifact and for the prior findings; the verification changed-file set) and
  `src/workflow/effect-runner.ts` (the call sites that render an assignment).
- `src/agent-host/tool-suggestions.ts` (`read`), `src/agent-host/tools.ts`
  (`grep`), `src/agent-host/bash-tool.ts` (`bash`), `src/agent-host/codemode.ts`
  and the host wiring that resolves whether `codemode` is registered.
- `scripts/efficiency/lib/queries.ts` (one additive query) and
  `docs/workflow-architecture.md` (assignment inputs and tool-description
  ownership).
- Focused tests for the exact brief text, the exact assignment lines and their
  absence, the bounded forwarding, the descriptions per registration, and the
  new query; plus the existing prompt/assignment assertions updated deliberately.
- Runtime cost: the assignment renders up to 399 B + forwarded lists more per
  run; no measurable engine cost.
