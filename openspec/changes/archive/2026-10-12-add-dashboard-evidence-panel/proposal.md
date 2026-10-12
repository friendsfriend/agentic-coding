# Proposal

## Why

Evidence is stored (change 7), but the developer cannot see it from the shell.
Screenshots and videos only help if they are a keypress away from the workflow
the agent was working on.

## What Changes

- An **Evidence** panel on the workflow dashboard listing manifest entries
  (kind glyph, caption, step/role, time, size), newest first, grouped by debug
  request when present.
- **Grid geometry.** The detail grid becomes 2-column, 4-row: the Evidence panel
  occupies a full-width fourth row and the Agents panel spans the first three
  rows, so Shift+J from the lowest left-column row or from Agents lands on
  Evidence (`dashboard-panel-navigation` and `dashboard-pane-grid` carry the
  modified requirements).
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

- New `src/tui/dash/panels/EvidencePanel.tsx`, `src/tui/dash/evidence-panel.ts`
  (the pure view model), `src/tui/dash/evidence-open.ts` (the stored file and its
  system opener), `src/tui/data/evidence.ts` (manifest + entry bytes),
  `src/tui/dash/panel-grid.ts` (the grid becomes 4 rows with a full-width
  Evidence row), `src/tui/dash/App.tsx` (the row in the body and its reads),
  `src/tui/dash/keybinds.ts`, `src/tui/shared/side-app.ts` (opener),
  `src/contracts/gateway.ts` + `src/server/{client,gateway/inProcess,evidence/routes}.ts`
  (the entry-bytes read both adapters serve), and
  `src/workflow/runtime/evidence-store.ts` (the recorded-name rule the dashboard
  checks, and the evidence root's write lock the deletion shares).
- Depends on `add-workflow-evidence-store`.
