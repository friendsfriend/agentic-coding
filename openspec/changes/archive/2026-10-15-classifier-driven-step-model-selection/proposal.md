# Proposal

## Why

Model selection is a per-definition privilege today. Routing runs in two fixed
passes that only the OpenSpec families reach: `core.route-plan` and
`core.route-apply` exist in the `openspec`, `openspec-propose`,
`openspec-apply`, `openspec-fusion` and `openspec-fusion-propose` graphs, and
their question sets come from two fixed step lists. Every other family —
`no-openspec`, `wiki`, `wiki-comments`, `research` — never asks the
classifier at all, so its steps keep whatever the preset's pool default says.
Observed on this machine: an `openspec` run recorded six routing decisions and
had `core.plan` and `core.implementation` re-selected onto a different profile,
while a `no-openspec` run from the same preset pinned every route to the pool
default and recorded none.

Two smaller holes make the same complaint reachable inside a routed run:

- The apply pass decides the model for `core.verification`, `core.wiki` and
  `core.archive` before the change exists, so a verifier's model is chosen from
  the plan rather than from the diff it will read.
- `core.research` declares no classification mode and has no pool key, so even a
  routed definition could not ask about it.

## What Changes

- **Per-step routing**: every classifiable agent step SHALL have a routing step
  immediately before it, in every workflow family. The route step enqueues
  exactly one `model.classify` routing effect for the step that follows and
  transitions to it, so each model is selected with the state as it stands when
  that step is about to run.
- **Every agent step is classifiable**: classifiable-ness and the selection mode
  (`single` / `roster`) SHALL come from the step's own behavior declaration, not
  from a hand-kept table beside it. `core.research` gains its mode and pool key;
  `wiki` steps keep theirs.
- **Every family is routed**: `no-openspec`, `wiki`, `wiki-comments` and
  `research` gain route steps, in a new definition version tier
  (`rounds + 700`). Earlier tiers keep their graphs, step lists and digests, so
  in-flight workflows are unaffected.
- **Pools are required per classifiable step**: coverage validation already fails
  startup for a missing pool; because more steps are now classifiable, a preset
  needs a pool for each of them (at minimum a new `core.research` pool), and the
  failure names the step.
- Gates, triage-role selection, and the fail-open contract are unchanged: a
  routing outage still completes the route step and keeps the tagged default.

## Capabilities

### New Capabilities
- `classifier-step-model-selection`: the per-step routing step, its question
  payload, the state each step's selection sees, and the definition-coverage
  invariant that every classifiable step is preceded by its route step.

### Modified Capabilities
- `classifier-model-pools`: routing is no longer two fixed passes over fixed
  step lists; classifiable-step metadata is read from step behavior, the
  classifiable set grows, and coverage validation now constrains every preset
  that runs any family.

## Impact

- `agentic-coding/src/workflow/steps/routing.ts`, `steps/index.ts`,
  `definitions/steps.ts` — the route steps and their behaviors.
- `agentic-coding/src/workflow/definitions/graphs/*.ts`, `edges.ts`,
  `manifest-policy.ts`, `registerBuiltins.ts` — the per-step routing tier
  (`rounds + 700`).
- `agentic-coding/src/workflow/profiles.ts` — classifiable-step metadata derived
  from step behavior; `core.research` becomes poolable.
- `agentic-coding/src/workflow/effect-runner.ts`,
  `runtime/reducers/effect-result.ts`, `classifiers.ts` — one routing question
  per request, its state, and its recorded decision.
- Presets: `core.research` (and any other newly classifiable step) must be added
  to `private-subscription`, `eon-subscriptions`, the builtin preset, and the
  test fixtures, or those workflows fail startup by design.
- Cost: one additional classifier call per agent step per run (N calls instead of
  two). Local classifier calls are cheap; the route step is durable, so a burst
  is bounded by the outbox like every other effect.
