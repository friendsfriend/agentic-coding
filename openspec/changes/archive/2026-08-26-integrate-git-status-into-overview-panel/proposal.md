## Why

The dashboard currently spends a dedicated panel on a small Git summary while the primary change overview does not show the repository state users need when assessing a workflow. Consolidating the status into the overview makes changed, new, deleted, and divergence counts visible in context and removes redundant panel navigation.

## What Changes

- Add a Git status summary to the dashboard's primary change/overview panel.
- Show distinct changed, new, and deleted file counts for the workflow worktree.
- Show commits ahead of and behind the configured upstream (head), with an explicit unavailable/no-upstream state when counts cannot be computed.
- Remove the separate Git status panel, its layout slot, and its panel-navigation/activation behavior.
- Preserve existing best-effort Git inspection behavior and ensure workflow metadata files do not inflate the file counts.
- Update dashboard data contracts, rendering, and focused tests to cover the consolidated status and the reduced panel set.

## Capabilities

### New Capabilities

- `dashboard-overview-git-status`: Display worktree file-change and upstream divergence counts in the dashboard overview panel.

### Modified Capabilities

- `dashboard-pane-grid`: Remove the separate Git status row from the detail-view grid; the overview panel owns the Git status display.

## Impact

- Dashboard data model and Git-status mapping in `agentic-coding/src/tui/dash/data.ts`.
- Detail dashboard rendering and panel focus order in `agentic-coding/src/tui/dash/App.tsx`.
- Dashboard UI/data tests under `agentic-coding/test/dash/`, including tests that currently assert a standalone Git panel.
- No external API or workflow-engine state changes; status remains read-only and is refreshed with dashboard data.
