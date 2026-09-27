# Proposal

## Why

Even after classifier-driven role selection, a triage agent run is still needed
every round purely to decide which changed files each selected verifier must see.
That is a per-file classification problem, which is the shape the JEV classifier
is good at, and paying an agent run (plus its latency and tokens) for it repeats
work the classifier can already do as part of the same request that selects the
roles.

## What Changes

- **BREAKING**: extend the per-round classifier request so it also returns, per
  changed file, which selected verifier roles need to see that file.
- Build the per-verifier scope from those tags instead of from a triage agent
  plan, and retire the `core.triage` agent step from the implementation loop.
- Keep the engine's validation strict: a tag may only name a role the classifier
  selected for the round, and only a file in the changed-file manifest.
- **BREAKING**: the `triage` agent role, its instruction asset, its tab, and its
  step leave the workflow.

## Capabilities

### New Capabilities
- `per-file-verifier-scoping`: classifier-provided per-file verifier role tags as
  the single source of each verifier's file scope.

### Modified Capabilities
- `workflow-verifier-role-coverage`: the verifier scope is derived from the
  classifier's per-file tags rather than an agent plan.

## Impact

- `agentic-coding/src/workflow/classifiers.ts`,
  `classifier-runner.ts`, `effect-runner.ts` (per-file tagging in the same
  request).
- `agentic-coding/src/workflow/steps/verification.ts` and
  `definitions/edges.ts` (triage step removal and the new scope derivation).
- `agent-definitions/instructions/triage.md`, the role catalog, and the
  regenerated embedded assets.
- The triage tab/pane grouping and any workflow view that shows a triage run.
- Depends on `classifier-driven-triage-routing`.
