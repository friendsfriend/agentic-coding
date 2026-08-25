## Why

Proposal workflows currently close the Herdr workspace as soon as planning validates, preventing developers from reviewing and explicitly accepting or closing the proposal. Keeping the proposal open through plan approval and completion makes the lifecycle match the dashboard actions while preserving proposal-only execution and same-checkout behavior.

## What Changes

- Change `standard-propose` from a planning-to-closed graph to `core.plan → core.plan-approval → core.completed → core.closed`.
- Preserve bounded planner retries for `blocked` and `failed`, and reuse plan-review approval, rejection, and comments routes with review-fix context.
- Add explicit developer close handling from `core.completed`; enqueue workspace close and cleanup only after that action.
- Keep `fusion-propose` planning-only and update its consolidation path to use plan approval and explicit completion/close without implementation or delivery effects.
- Ensure registry, runtime lifecycle, dashboard state/actions, tests, and user-facing workflow documentation reflect the revised proposal lifecycle.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-proposal-only`: Proposal workflows remain open through plan approval and completed state, retain same-checkout startup, and close only after explicit developer action; standard and fusion proposals continue to exclude implementation, verification, archive, delivery, and pull-request effects.
- `workflow-definition-registry`: The registered `standard-propose` and `fusion-propose` graphs explicitly include the shared plan-approval and completed steps plus the legal close path, while retaining their planning retry bounds and excluding unrelated execution steps.

## Impact

- Workflow manifests and registry assertions in `agentic-coding/src/workflow/definitions.ts` and `agentic-coding/test/workflow-registry.test.ts`.
- Runtime effect scheduling and proposal lifecycle coverage in `agentic-coding/src/workflow/runtime.ts` and workflow runtime/effects/plan-fusion tests.
- Dashboard state/action presentation and affected dashboard tests under `agentic-coding/src/tui/dash/` and `agentic-coding/test/dash/`.
- Workflow documentation in `README.md` and the modified OpenSpec capability specifications. No public API, branch, or worktree behavior changes are intended.
