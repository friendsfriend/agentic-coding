## Why

Stage A (`restructure-repo-for-agent-use`) activated the `StepBehavior` seam on `StepDefinition` and proved it is digest-free, but it deliberately moved only role selection — the smallest, best-covered branch. The rest of each step's semantics still lives as `if (stepId === "core.x")` branches inside shared engine functions, so changing one step still means editing code every other step depends on.

Concretely, in `agentic-coding/src/workflow/runtime.ts`:

- `transition()` is a single function containing nine consecutive step-id branches: the `fusion.plan` self-loop draft-preservation rule, the `core.triage` / `core.verification` round-counter seeding, a five-clause ordered context carry-over condition, the `selectedRoles` extraction with its empty-selection `testRunStarted` shortcut, the `core.plan` and `core.implementation` `step.mode` assignment, and the `core.completed` / `core.closed` status assignment.
- `validateStepEvidence()` holds the planning-artifact guard, the implementation completed-`tasks.md` guard with its `definition.id !== "no-openspec"` exemption, and the archive move-detection guard.
- `actions()` is a 120-line nested ternary that additionally contains `core.wiki-approval` **twice** — once inside the research sub-tree and once in the main chain — which is exactly the duplication that makes an edit to one approval step silently miss the other.
- `enterStep()` holds the `core.delivery` and `core.closed` effect enqueues and the `fusion.plan` relaunch-skip rule.

The same pattern continues outside the engine: `effect-runner.ts` re-declares `["core.triage", "core.verification"]` as a literal, branches on `core.triage` for changed files, on `core.research` for handoff rendering, and twice on `core.wiki` for objective/permission text; `assignment.ts` carries a `{ wiki: "wiki-openspec.md", "research-wiki": "wiki-research.md" }` map and a `core.research` special case; `profiles.ts` carries one `core.research` route check.

## What Changes

- Extend `StepBehavior` with the remaining declarative hooks: `validateEvidence`, `onArrive`, `onEnter`, `developerActions`, `assignmentInputs`, and `instructionAssetForRole`. All stay excluded from `stepDigest()` exactly as the stage-A role hooks are.
- Move each step's entry guard out of `validateStepEvidence` into that step's `validateEvidence` hook, preserving the identical `entry-guard` error code and message text.
- Replace `transition()`'s step-id branches with one `onArrive` call per transition. The five-clause context carry-over becomes an explicit ordered resolver whose precedence is preserved exactly and asserted directly, rather than an implicit ternary chain.
- Replace `enterStep()`'s step-id branches with `onEnter`, which receives an `enqueue` callback and a role-skip predicate rather than a database handle.
- Replace `actions()` with a delegation to `developerActions`, keeping only the engine-owned `status === "paused"` → `resume` short-circuit. The duplicated `core.wiki-approval` branch collapses to one definition.
- Remove the step-identity branches from `effect-runner.ts`, `assignment.ts`, and `profiles.ts` by reading `assignmentInputs`, `instructionAssetForRole`, and a declared round-scoping flag from the step. Effect mechanics (`agent.launch`, pane ownership, `wiki.verify`, delivery) are untouched.
- Add a manifest-level `policy` block (target kind, checkout requirement, read-only-researcher requirement) replacing the engine's `isWikiWorkflowTarget` / `isResearchWorkflowTarget` / definition-id array checks — **with an explicit definition-version bump**, because the manifest digest spreads the whole manifest (see design D1).
- **BREAKING (internal only):** `WorkflowManifest` gains a field, so every registered definition digest changes. This is handled by a version bump and a migration path, not by silent digest drift; no public API, CLI verb, or artifact schema changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-definition-registry`: the registered step contract's behavior block extends from role selection to the step's entry guards, arrival semantics, entry effects, and developer actions; workflow manifests gain a declarative policy block that replaces engine-side identifier checks.

## Impact

- **Depends on:** `restructure-repo-for-agent-use` (stage A) being implemented and archived. The hook signatures added here must match the `StepBehavior` shape stage A actually produced — re-verify before implementing.
- **Code (modified):** `agentic-coding/src/workflow/steps/*.ts` (each family gains its own hooks), `registry.ts` (manifest policy + validation), `definitions.ts` (policy on manifests, version bump), `runtime.ts` (`transition`, `enterStep`, `validateStepEvidence`, `actions` reduced to delegations), `effect-runner.ts`, `assignment.ts`, `profiles.ts`.
- **Tests:** `test/workflow-steps.test.ts` extended with context carry-over precedence and entry-guard parity; `test/workflow-runtime.test.ts` remains the behavior oracle; `test/workflow-effects.test.ts` and `test/workflow-adapters.test.ts` cover the assignment path.
- **Highest risk:** the context carry-over precedence is load-bearing and its failure mode is silent — a wrong `step.context` surfaces as a wrong or empty agent assignment several steps later, not as a thrown error.
