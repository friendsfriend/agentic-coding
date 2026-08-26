## 1. Panel grid navigation module

- [x] 1.1 Create `src/tui/dash/panel-grid.ts` implementing the 3×2 occupancy grid (Change top-left, OpenSpec below Change when artifacts are present, Agents spanning the right column, Current task spanning the full-width bottom row) and `movePanel(active, direction, opts)` with edge wrap, span skipping, and no-op on rows/columns with no distinct panel; verify `bun run type-check` passes.
- [x] 1.2 Add unit tests covering every panel × direction transition from the design's tables for both the artifacts-visible and artifacts-hidden states (including wrap and no-op cases); verify with `bun test test/dash/panelGrid.test.ts`.

## 2. Wire navigation into the dashboard

- [x] 2.1 Add `"H"` and `"L"` to the detail keymap layer binding list in `src/tui/dash/App.tsx` next to the existing `"J"`/`"K"` so Shift+H/Shift+L resolve to the detail handler; verify the keymap resolution via lint, type-check, and the integration tests in 2.3.
- [x] 2.2 Replace the 1D-only panel-switch block in `handleKey` so Shift+J/K/H/L call `movePanel` with down/up/left/right; unbind `Tab`/`Shift+Tab` from panel navigation (removed from the detail keymap layer so the shell's tab bar keeps them) and drop the `[0, 6, 1, 2]` cycle; leave the unshifted `j`/`k`/`↑`/`↓` in-panel scrolling branches untouched; verify `bun run lint` and `bun run type-check` pass.
- [x] 2.3 Add integration tests in `test/dash/` (pattern: `testRender` + `t.mockInput.pressKey("j", { shift: true })` etc.) asserting focus moves per the grid — including wrap from the edges and that `Tab`/`Shift+Tab` do NOT move panel focus — and verify with `bun test`.
- [x] 2.4 Update the help modal's Navigation section in `App.tsx` to list Shift+J/K/H/L as directional panel movement while keeping the existing focused-panel scroll entry; verify the updated entries render in the help frame.

## 3. Verification

- [x] 3.1 Run the full suite (`bun test`, `bun run lint`, `bun run type-check`, `bun run build`) and confirm zero failures and zero diagnostics.
- [x] 3.2 Manual smoke test via `bun run dev:ui-dash`: in the detail view with artifacts present, press Shift+J/K/H/L from every panel and confirm movement and edge wrap, including Shift+H/L no-op on the Current task row and OpenSpec reachability only while artifacts are listed.