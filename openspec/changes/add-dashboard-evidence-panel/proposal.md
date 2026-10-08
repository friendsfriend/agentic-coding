# Proposal

## Why

Evidence is stored (change 7), but the developer cannot see it from the shell.
Screenshots and videos only help if they are a keypress away from the workflow
the agent was working on.

## What Changes

- An **Evidence** panel on the workflow dashboard listing manifest entries
  (kind glyph, caption, step/role, time, size), newest first, grouped by debug
  request when present.
- A preview area: when the terminal supports the kitty graphics protocol (as
  reported by the OpenTUI renderer), screenshots and video posters render inline
  through OpenTUI's image renderable; otherwise the preview shows metadata only.
- `Enter` opens the selected file with the system opener (`open` /
  `xdg-open`) through `src/tui/shared/side-app.ts`; `y` copies the file path.
- Keybinds declared in the dashboard catalog; footer and `?` help verified.
- The panel is read-only: no delete or edit actions.

## Capabilities

### New Capabilities

- `dashboard-evidence-panel`: evidence listing, inline image preview with
  capability detection, external open, keybinds.

## Impact

- New `src/tui/dash/panels/EvidencePanel.tsx`, `src/tui/dash/keybinds.ts`,
  `src/tui/dash/panel-grid.ts`, data loading via the `evidence` observation
  (`src/tui/data/`), `src/tui/shared/side-app.ts` (opener).
- Depends on `add-workflow-evidence-store`.
