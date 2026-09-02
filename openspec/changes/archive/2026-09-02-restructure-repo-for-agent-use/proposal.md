## Why

Every workflow change currently breaks something unrelated, because a step's semantics do not live with the step. `StepDefinition` in `agentic-coding/src/workflow/registry.ts` already carries `enter`/`reduce` seams, but every built-in step wires them to a no-op, so the real behavior of each step is scattered as `if (stepId === "core.x")` branches across six unrelated files. Agent role selection is the clearest and most-covered instance: the same role table is written twice, verbatim, in `runtime.ts` (`roleForStep`, line 3796) and `cli.ts` (`rolesForDefinition`, line 989), including the `no-openspec` drop of `openspec-verifier` and the `research` → `research-wiki` selection. Adding, renaming, or re-routing a step means finding every copy, and missing one fails silently at runtime rather than at type-check.

This change makes the existing seam real for role selection only, so a step's roles become a single declarative fact owned by the step. Following the developer's sequencing decision, it is stage A of four: the smallest, best-covered branch lands first and proves the seam (including digest stability) before evidence guards, transition semantics, developer actions, the `runtime.ts` file split, and dashboard action derivation follow as separate changes.

## What Changes

- Add `agentic-coding/src/workflow/steps/`: a `StepBehavior` seam type plus one behavior module per step family (planning, implementation, verification, wiki, research, lifecycle), each owning its own step's role table and nothing else in this stage.
- Widen `StepDefinition` with an optional `behavior?: StepBehavior` field. `stepDigest()` stays byte-for-byte unchanged so behavior is excluded from the digest exactly as instruction assets already are — no pinned workflow's digest may move.
- Make `steps/index.ts` the single source of truth for role selection, exposing `stepBehavior(id)` for the engine and `rolesForStep(...)` for the CLI and dashboard read path, with a construction-time exhaustiveness assertion so a step referenced by a manifest without a behavior module fails at registry construction rather than silently at runtime.
- Delete the duplicated role logic: `runtime.ts`'s `roleForStep` is removed in favour of `behavior.roles(...)`, and `cli.ts`'s `rolesForDefinition` keeps its export and signature but becomes a thin adapter over `rolesForStep`, so `src/tui/dash/engine.ts` and `test/workflow-registry.test.ts` need no import churn.
- Add a pinned-digest regression guard asserting every registered definition digest and step digest is identical before and after the seam, plus role-parity coverage for every agent step across every definition id and fusion planner count.
- Document the seam in `agentic-coding/docs/workflow-architecture.md` and point `AGENTS.md` at it, including the rule this change starts enforcing: role knowledge belongs in `src/workflow/steps/`, nowhere else.
- Not breaking: no public export, CLI verb, manifest, definition version, digest, workflow view, or SQLite schema changes. `runtime.ts`, `definitions.ts`, and `cli.ts` keep their exact current export surface, so the 2605-line `test/workflow-runtime.test.ts` suite remains an unmodified behavior oracle for this refactor.

## Capabilities

### New Capabilities

None. This change extends an existing registry contract rather than introducing a new capability.

### Modified Capabilities

- `workflow-definition-registry`: the registered step contract gains a declarative, digest-excluded behavior block, and agent role selection becomes a property of the registered step definition that every consumer reads, rather than logic each consumer re-implements.

## Impact

- **Code (new):** `agentic-coding/src/workflow/steps/{types,index,planning,implementation,verification,wiki,research,lifecycle}.ts`, `agentic-coding/docs/workflow-architecture.md`.
- **Code (modified):** `agentic-coding/src/workflow/registry.ts` (field + validation, digest untouched), `agentic-coding/src/workflow/definitions.ts` (attach behavior in the step catalog), `agentic-coding/src/workflow/runtime.ts` (delete `roleForStep`, delegate), `agentic-coding/src/workflow/cli.ts` (`rolesForDefinition` becomes an adapter), `AGENTS.md`.
- **Tests:** new `agentic-coding/test/workflow-steps.test.ts`; `test/workflow-cli.test.ts` and `test/workflow-registry.test.ts` gain role-parity assertions without changing imports.
- **Not touched in this change:** `effect-runner.ts`, `assignment.ts`, `profiles.ts`, `contracts.ts`, `src/tui/dash/data.ts`, `src/tui/dash/App.tsx`, the legacy/policy dual definition registration, and the SQLite store. Each is assigned to a planned follow-up change: `move-step-semantics-to-behavior-hooks` (stage B), `split-workflow-god-modules` (stage C), or `derive-dashboard-actions-from-engine` (stage D). See `design.md` D7.
- **Risk concentrated in one place:** definition-digest drift would strand in-flight workflows pinned to `{id, version, digest}`. The guard test lands before any behavior moves.
