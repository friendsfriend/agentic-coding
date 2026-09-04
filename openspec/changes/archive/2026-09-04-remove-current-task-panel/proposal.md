## Why

The dashboard's Current task panel consumes space and focus navigation without serving the user's workflow. The OpenSpec artifact list should remain compact even when a change has many artifacts, while still allowing every artifact to be selected.

## What Changes

- **BREAKING** Remove the Current task panel, its task-detail activation, and its task-viewport presentation from the dashboard detail view.
- Reflow the remaining Change, OpenSpec, and Agents panels into a two-column layout and update directional focus navigation to target only those rendered panels.
- Limit the visible OpenSpec artifact list to five rows; when focused, unshifted `j`/`k` and arrow keys move its selection and scroll the list as needed.

## Capabilities

### New Capabilities
- `dashboard-openspec-panel`: Provides a bounded, keyboard-navigable OpenSpec artifact list in the dashboard detail view.

### Modified Capabilities
- `dashboard-pane-grid`: Removes the full-width Current task row from the dashboard layout contract.
- `dashboard-panel-navigation`: Updates directional navigation for the three remaining detail panels.
- `dashboard-task-progress`: Removes the dashboard task-panel viewport and task-detail interaction.

## Impact

- `agentic-coding/src/tui/dash/App.tsx` dashboard rendering and panel keyboard actions.
- `agentic-coding/src/tui/dash/panel-grid.ts` grid geometry and focus movement.
- Dashboard panel-grid, navigation, user-action, and task-viewport tests; obsolete task viewport data helpers and tests can be deleted if no remaining callers exist.
- No workflow runtime, API, or dependency changes.
