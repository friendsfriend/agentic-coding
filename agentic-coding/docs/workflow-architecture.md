# Workflow architecture

Workflow code follows a one-way flow:

1. `src/workflow/definitions.ts` declares manifests and graph edges.
2. `src/workflow/steps/` owns per-step behavior, including agent role knowledge.
3. `src/workflow/runtime.ts` applies step-agnostic state-machine mechanics.
4. Effects execute external work.
5. CLI and TUI modules present workflow state.

## Step ownership

Role knowledge belongs only in `src/workflow/steps/`. The engine, CLI, and
dashboard read the registered step behavior instead of keeping their own role
tables. Step behavior is pure and receives no database, engine, or filesystem
handle.

There are two intentional role-resolution moments:

- `candidateRoles` resolves every role a definition can use before routing is
  pinned. It is used to validate profile coverage and build routing.
- `roles` resolves the roles to fan out now from the pinned workflow snapshot.

They are separate because verification selects a subset at runtime, while its
candidate list must include every verifier for routing. Other steps derive both
answers from the same step-owned rule.

## Adding a step

1. Add the versioned step contract and graph references in `definitions.ts`.
2. Add a behavior entry in the appropriate module under `src/workflow/steps/`.
3. Provide both role hooks for agent steps, or an empty behavior for developer
   and system steps.
4. Keep behavior pure and module-level; do not import runtime, definitions, or
   CLI from a step module.
5. Add role parity and digest coverage, then run the focused workflow tests,
   type-check, format, lint, and build.

## Planned follow-ups

This change is stage A only. The following branches remain intentionally outside
this change:

- **Stage B — `move-step-semantics-to-behavior-hooks`:** evidence guards,
  transition semantics, developer actions, remaining step-id branches, and
  manifest-level policy.
- **Stage C — `split-workflow-god-modules`:** split `runtime.ts`,
  `definitions.ts`, and `cli.ts` into focused modules behind compatibility
  barrels.
- **Stage D — `derive-dashboard-actions-from-engine`:** derive dashboard action
  availability from the engine's workflow view.
