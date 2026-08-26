## Context

The dashboard already renders `DashboardData.request` in the Change panel, but `loadDashboard` currently populates that field only by summarizing `.herdr-workflow/<change>/request.md`. Current workflows persist the developer's task as `WorkflowMetadata.task` in the engine snapshot and do not create that legacy file. The typed `WorkflowView` omits the metadata task, so the dashboard projection cannot access it and falls back to “Not created yet”.

The fix crosses the workflow-view contract and the dashboard data projection, but does not change workflow persistence or command behavior.

## Goals / Non-Goals

**Goals:**

- Carry the optional original task from the workflow snapshot through `WorkflowView` and dashboard state.
- Prefer the current metadata task when building the Change panel request.
- Keep the legacy `request.md` lookup as a fallback for older workflows or snapshots without metadata.
- Add regression coverage for propagation, current-workflow loading, and legacy fallback.

**Non-Goals:**

- Do not change how workflow tasks are entered, stored, or passed to agents.
- Do not redesign the Change panel or add a new modal for request details.
- Do not alter request text, workflow actions, or external APIs.

## Decisions

- **Expose task on the typed workflow view.** Add an optional task field sourced from `snapshot.metadata.task`, and preserve it in all valid view paths that have a snapshot, including the pin-mismatch diagnostic view. This keeps the dashboard dependent on the engine's public view rather than opening the workflow store itself. Direct dashboard database access and recreating a request artifact were considered and rejected because they duplicate persistence knowledge and do not fix the current-view contract.
- **Use metadata first, legacy artifact second.** Dashboard loading will use the non-empty task from the projected workflow state as the request; when it is absent, it will retain the existing `request.md` summary behavior. This supports current workflows without breaking migrated or older workflows that still have the artifact. Reading the artifact first was rejected because it is absent in the affected current workflow path.
- **Keep the existing rendering path.** The Change panel will continue rendering `DashboardData.request` inside its existing scrollable content. No layout or keybinding change is needed; the regression should be fixed at the data boundary where the value is lost.

## Risks / Trade-offs

- [Legacy workflows may have neither metadata task nor `request.md`] → Preserve the existing “Not created yet” fallback rather than inventing request text.
- [A task can be substantially longer than the compact artifact summary] → Keep the existing scrollable Change panel and rely on its bounded viewport; do not silently replace the developer's request with unrelated workflow status text.
- [Adding a field to `WorkflowView` affects typed consumers] → Make the field optional so existing fixtures and diagnostic views remain valid, and cover the projection in dashboard tests.
