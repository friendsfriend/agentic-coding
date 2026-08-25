## Why

Since the propose-only/fusion workflow feature landed, real workflows report their step as engine step ids (`core.developer-review`, `core.plan-approval`) while the dashboard's required-user-action matching still expects legacy phase names (`developer-review`, `proposed`). As a result the developer review no longer opens the changed-files review popup directly; instead a generic "Action required · Developer review" notice modal appears with nothing actionable in it. Reviews used to open directly, so this is a regression that blocks the core modal flow.

## What Changes

- Normalize the required-user-action keys so they are stable identifiers (`plan-review`, `developer-review`) independent of whether the workflow reports a legacy phase name or an engine step id.
- Ensure every gated step (plan approval, developer review) auto-opens its actual review popup — the artifact list / changed-files modal — instead of the generic "due" notice ListViewModal, regardless of phase naming.
- Extend test coverage to engine-style phase names (`core.*`), which today only exist for legacy names, so this class of regression cannot slip through again.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `dashboard-developer-review-popup`: clarify that the changed-files review popup opens directly whenever the workflow reaches the developer review step — including when the phase is reported as the engine step id `core.developer-review` — and never falls back to the generic action-notice modal.
- `dashboard-plan-review-comments`: clarify that the artifact-list review popup opens directly whenever the workflow reaches the plan approval gate — including when the phase is reported as the engine step id `core.plan-approval` — and never falls back to the generic action-notice modal.

## Impact

- `agentic-coding/src/tui/dash/data.ts` (`requiredUserActionFor` returns stable action keys).
- `agentic-coding/src/tui/dash/App.tsx` (direct-open matching for `openRequiredUserAction` and the auto-open effect stays keyed on the stable ids).
- `agentic-coding/test/dash/data.test.ts` and `agentic-coding/test/dash/userActions.test.tsx` (coverage for `core.*` phase naming).
