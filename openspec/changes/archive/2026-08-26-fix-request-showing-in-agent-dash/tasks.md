## 1. Carry the task through the workflow view

- [x] 1.1 Add an optional `task` field to the `WorkflowView` contract and map it from `snapshot.metadata.task` in the normal workflow view.
- [x] 1.2 Preserve the optional task in the workflow view's pin-mismatch diagnostic path without changing legacy or unavailable-view behavior.
- [x] 1.3 Project the workflow-view task into `WorkflowState` in `viewToDashboardState`.

## 2. Populate and render the dashboard request

- [x] 2.1 Update `loadDashboard` to prefer a non-empty projected workflow task and fall back to the existing legacy `request.md` summary when no task is present.
- [x] 2.2 Keep the existing Change-panel REQUEST rendering and explicit empty-state behavior, verifying that current workflow tasks are visible without `request.md`.

## 3. Verify current and legacy behavior

- [x] 3.1 Add data/projection tests proving a workflow metadata task reaches dashboard state and `loadDashboard` displays it when the legacy artifact is absent.
- [x] 3.2 Add a regression test for the legacy `request.md` fallback and the no-source “Not created yet” behavior.
- [x] 3.3 Run the dashboard test suite, `bun run type-check`, and `bun run lint` from `agentic-coding/`.
