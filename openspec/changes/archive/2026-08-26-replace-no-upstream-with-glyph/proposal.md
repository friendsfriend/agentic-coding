## Why

The dashboard overview's Git status line currently spells out `no upstream`, consuming valuable horizontal space in the compact TUI view. Replacing that label with the configured question-mark glyph preserves the unavailable-upstream signal while making the overview more compact.

## What Changes

- Replace the muted inline `no upstream` label in the dashboard overview Git status line with ``.
- Keep the existing no-usable-upstream behavior, including omitted divergence counts, muted styling, and display of file counts and branch name.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-overview-git-status`: The compact overview line uses the `` glyph instead of the textual `no upstream` indication when divergence counts are unavailable.

## Impact

- Affects the dashboard overview rendering in `agentic-coding/src/tui/dash/App.tsx`.
- Updates the existing dashboard Git-status capability specification and its rendering-focused scenario; no API, data model, or dependency changes are expected.
