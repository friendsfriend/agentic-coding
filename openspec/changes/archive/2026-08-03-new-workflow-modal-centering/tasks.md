## 1. Fix shared dash modal anchoring

- [x] 1.1 In `agentic-coding/src/tui/dash/ui/GenericModal.tsx`, wrap the absolute overlay `<box>` in `<Portal>` (imported from `@opentui/solid`, no `mount` prop so it anchors to `renderer.root`). Do not change overlay sizing, `zIndex`, or mouse handlers. This covers the new-workflow modal and all other modals sharing this component.
- [x] 1.2 Apply the identical `<Portal>` wrap to the overlay in `agentic-coding/src/tui/dash/devenv-ui/components/GenericModal.tsx` (used by the diff-view modal).

## 2. Verification

- [x] 2.1 Add a regression test (core-level renderer test, no solid-js) that renders a nested tab-content layout like the real app (header + tab bar + status bar offsetting a smaller content box), mounts a GenericModal-style absolute overlay at the renderer root, and asserts the dialog title lands at the terminal center row (`(terminalHeight - dialogHeight) / 2`), not offset by the chrome height.
- [x] 2.2 Run the full test suite (`bun test` in `agentic-coding/`) — all existing tests pass.
- [x] 2.3 Run `bun run dev:ui` (home mode) and `bun run dev:ui-dash` (per-workflow dashboard); open the new-workflow modal (`n`), help (`?`), and one error dialog; confirm each is centered on the terminal with the backdrop covering the header, tab bar, and status bar, and that typing/focus and Esc/backdrop-click still work.
