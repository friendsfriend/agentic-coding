## Why

The dashboard's Change panel no longer shows the task/request that started a workflow because the current workflow stores it in workflow metadata while the dashboard still reads a legacy `request.md` file. Developers therefore lose the primary context for the change when using the TUI.

## What Changes

- Preserve the workflow's requested task when converting the engine workflow view into dashboard state.
- Display the request from current workflow metadata in the dashboard, with the legacy request artifact retained as a compatibility fallback where available.
- Cover request propagation and rendering data behavior with dashboard tests.

## Capabilities

### New Capabilities

- `dashboard-user-request`: The agent dashboard displays the workflow's original user request in the Change panel.

### Modified Capabilities

- None.

## Impact

- `agentic-coding/src/tui/dash/engine.ts` and `agentic-coding/src/tui/dash/data.ts` dashboard state/data loading.
- Dashboard data and TUI tests under `agentic-coding/test/dash/`.
- No workflow command, persistence schema, or external API changes.
