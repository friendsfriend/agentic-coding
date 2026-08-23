## Why

In the per-workflow agent dash, the vertical gutters between panels do not line up: the top row's two columns are sized with fixed `width: "50%"` plus a 1-column gap, so the row is one column wider than the terminal and its middle gutter lands one column right of the gutters in the two bottom rows, which split space flexibly. The result is visibly uneven spacing between the left and right column panes.

## What Changes

- Rework the top row of the workflow dashboard detail view (`Change`/`OpenSpec` column and `Agents` panel) to size its two columns with flexible growth (`flexGrow: 1`, `flexBasis: 0`, `minWidth: 0`) instead of fixed `width: "50%"` with `flexShrink: 0`, matching the sizing already used by the bottom rows (`Current task`/`Verification` and `Git status`/`Traces`).
- No behavior outside visual layout changes; all panel content, focus order, and keybindings stay as-is.

## Capabilities

### New Capabilities

- `dashboard-pane-grid`: Defines that the workflow dashboard detail view arranges its panels on a consistent two-column grid with uniform gutters between columns and rows.

### Modified Capabilities

<!-- No existing capability covers dash pane layout; this is a new capability. -->

## Impact

- Code: `agentic-coding/src/tui/dash/App.tsx` (workflow detail view layout JSX only).
- No API, data, dependency, or workflow-engine changes.
- Purely visual fix in the TUI; no state or persistence affected.
