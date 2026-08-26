## Why

The workflow dashboard detail view arranges its panels on a 2D grid (Change/OpenSpec on the left, Agents on the right, Current task on a bottom row), but panel switching is a one-dimensional cycle: shift+j and shift+k move through a fixed panel order. Users must wrap around the whole ring to reach a panel that is visually one step away, which becomes slower and more unintuitive as the dashboard grows.

## What Changes

- Replace the one-dimensional panel cycle with 2D, vim-style positional navigation using shift as the modifier:
  - **Shift+J** — move to the panel below; at the bottom, wrap to the top of the column.
  - **Shift+K** — move to the panel above; at the top, wrap to the bottom of the column.
  - **Shift+H** — move to the panel to the left; at the left edge, wrap to the right.
  - **Shift+L** — move to the panel to the right; at the right edge, wrap to the left.
- Navigation operates on the currently rendered panel grid: the OpenSpec panel is only reachable while it is actually displayed (artifacts exist), instead of being part of a static cycle.
- Keep unshifted `j`/`k` and `↑`/`↓` for scrolling/selection inside the focused panel (unchanged behavior).
- `Tab` / `Shift+Tab` are NOT bound to panel navigation — they stay unbound in the detail view so the shell's tab bar keeps them (terminal tab switching).
- Update the help text to document the new keybinds.

## Capabilities

### New Capabilities
- `dashboard-panel-navigation`: 2D positional (vim-style) panel navigation for the workflow dashboard detail view, with edge wrap and a grid derived from the rendered panel layout.

### Modified Capabilities
<!-- None: no existing spec defines panel navigation behavior. `dashboard-pane-grid`
     (layout/alignment) and `dashboard-layout-spacing` (rendering) are unaffected:
     the physical arrangement of panels does not change. -->

## Impact

- `agentic-coding/src/tui/dash/App.tsx` — panel-switch key handling in the detail view (`handleKey`), keymap bindings (add `H`/`L` beside existing `J`/`K`), and the help section entries.
- New small pure navigation module for the 2D panel-grid model (or extension of `navigation.ts`) with unit tests.
- New test file under `agentic-coding/test/dash/` (integration: key presses switch focus per the grid).
- New spec capability `openspec/specs/dashboard-panel-navigation`.