## Why

The shared dashboard shell currently reserves a blank row above the header, below the footer, and a column at each terminal edge. Removing that outer chrome gives both `agentic-coding home` and per-workflow `agentic-coding dash` more usable space and aligns their surfaces with Herdr.

## What Changes

- Remove the shared dashboard shell's outer top, bottom, left, and right spacing.
- Remove the detail dashboard content's remaining outer right inset so both dashboard modes use the full terminal width.
- Preserve intentional internal padding inside headers, tabs, panels, lists, and modal content.
- Keep dashboard header, tab bar, content, footer, and interaction behavior unchanged apart from their edge placement.

## Capabilities

### New Capabilities

- `dashboard-layout-spacing`: Defines edge-to-edge layout behavior for the home and per-workflow dashboard shells.

### Modified Capabilities

<!-- No existing capability specifically defines dashboard shell edge spacing. -->

## Impact

- `agentic-coding/src/tui/otel/app/App.tsx` shared shell layout used by home and per-workflow dashboards.
- `agentic-coding/src/tui/dash/App.tsx` per-workflow content wrapper.
- Dashboard rendering tests may need coverage for the first/last occupied columns and rows at the shell boundary; no public API or dependency changes are expected.
