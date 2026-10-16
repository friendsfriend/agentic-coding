# Design

## Context

Routing today is two system steps (`core.route-plan`, `core.route-apply`) that
each build one System One request from a fixed step list
(`PLAN_PHASE_STEPS`, `APPLY_PHASE_STEPS`, filtered by the definition's steps)
and one `poolEntries` lookup per step. The graph decides who is routed; the
engine only knows the two passes. Steps that launch agents declare their
selection mode (`classification: "single" | "roster"`) in
`src/workflow/steps/`, and `profiles.ts` keeps a parallel `POOL_STEPS` table
that must agree with it. `core.research` appears in neither.

## Goals / Non-Goals

**Goals:**

- Every agent step of every workflow family selects its model through the
  classifier, immediately before that step runs.
- The classifiable set and each step's mode come from one place: the registered
  step behavior.
- A missing pool is a configuration error that names the step, not a silent
  fallback to a default the classifier never saw.
- Earlier definition versions and in-flight workflows stay byte-compatible.

**Non-Goals:**

- Changing gates, triage-role selection, or the fail-open contract.
- Per-verifier-role models: all roles of `core.verification` keep sharing the
  step's one pool.
- Selecting a model for developer-owned steps (`core.plan-approval`,
  `core.wiki-approval`, review steps), which launch no agent.
- Including diffs in every routing state; see Decisions.

## Decisions

### D1. One route step per classifiable agent step, in the graph

A system step `core.route-<domain>` (`routingBehaviorStep(targetStepId)`)
enqueues exactly one `model.classify` with
`{ integration: routing, stepId: <target> }` on entry and, on completion,
transitions to the target on outcomes `complete`/`empty` so a fail-open result
still runs the step with its pinned default.

Rejected alternative: teaching the engine to hold an agent step's launch until a
routing answer arrives. It removes the graph edits but puts the delay inside
`enterStep`/effect completion, the part of the engine that owns leases, retries
and resume; a bug there strands or double-launches runs. The route-step shape is
already proven by `core.route-plan`/`core.route-apply`/`core.triage-route`.

### D2. Every edge into a classifiable step lands on its route step

`workflowEdges` and each family graph keep one rule: the only edge into a
classifiable agent step comes from its route step. Loops therefore re-route:
`core.implementation --blocked--> core.route-implementation --complete-->
core.implementation` selects a model again for the retry, and a verification
round that loops back re-routes the step it returns to. Loop budgets
(`maxAttempts`) move to the `from -> route` edge so the retry count is unchanged.

### D3. State is the current state, bounded

The route step for a pre-plan step sends the task; a post-plan step sends the
task plus the change's planning artifacts and the changed-file *paths* (no diff
bodies). Diffs are deliberately excluded: every step would pay the corpus
assembly and the request size for a decision whose inputs are the step's own
prompt, and verifier models are selected per round anyway. A bounded
`planSummary` plus paths is enough for "which model should run this step".

### D4. Classifiable metadata comes from step behavior

`classification` on every agent step behavior becomes the single source; the
`POOL_STEPS` table is replaced by a lookup derived from the registered
behaviors, and a test asserts the two can no longer diverge. `core.research`
gains `classification: "single"` and a pool key.

### D5. New version tier, not an edit of a registered one

Per-step routing changes every family's step list, so it ships as
`definitionVersionForStepRouting(rounds) = rounds + 700` registering all
families, exactly like the triage-routing and stage-gate tiers before it. A
digest spreads the whole manifest: mutating a registered tier would strand every
workflow pinned to it.

### D6. Pools are required

Coverage validation already fails when a classifiable step has no pool. Since the
classifiable set grows to every agent step, the effective presets must define
`core.research` (and the `wiki`-family steps they already define). Fail-open at
runtime is unchanged: a classifier outage keeps the step's tagged default.

## Risks / Trade-offs

- **Classifier calls per run grow from 1-2 to N** (one per agent step, plus one
  per verification round for the steps it re-enters). Accepted: the decision is
  what the user asked for, and the effect is durable and bounded by the outbox.
- **A routing outage now delays every agent step** by the classifier start bound
  rather than failing one pass earlier. `ClassifierUnavailable` fails open
  immediately, so only a hung provider pays the bound.
- **Presets without a `core.research` pool break research starts** until
  updated. This is the intended behavior of D6 and is called out in the error.
- **Test churn**: sequences in the engine/e2e suites gain route steps.

## Migration

New starts resolve the `rounds + 700` tier per definition. Existing workflows
keep their pinned version and digest. Presets must add pools for the newly
classifiable steps; the startup error names each missing step.
