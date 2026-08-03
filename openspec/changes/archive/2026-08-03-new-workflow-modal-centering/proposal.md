## Why

The single-binary consolidation (commit `4e10ebb`) moved the dashboard into the merged tab-bar shell: `DashHome`/`DashApp` now render inside the tab-content box, which is offset by the header, tab bar, and status bar. Dash modals — starting with the new-workflow modal — draw their overlay as `position="absolute"` anchored to that tab-content parent while sizing it to full terminal dimensions, so the dialog centers ~5 rows below the terminal's true center and its backdrop stops at the content area.

## What Changes

- The shared dash modal overlay (`agentic-coding/src/tui/dash/ui/GenericModal.tsx`, used by the new-workflow modal, help, error dialog, filter, sort, theme picker, verdict, findings, cost, events, verification timeline, progress, and list-view modals) mounts at the renderer root via `@opentui/solid`'s `Portal` instead of anchoring to the tab-content box. Modals center at the true terminal center; the backdrop dims the full terminal including header, tab bar, and status bar.
- The duplicated `devenv-ui` modal overlay (`agentic-coding/src/tui/dash/devenv-ui/components/GenericModal.tsx`, used by the diff-view modal) receives the same fix.
- Otel modals are unaffected: they already render at the OtelApp root box, which spans the terminal.

## Capabilities

### New Capabilities
- `dashboard-modal-centering`: Dashboard modal overlays in the `agentic-coding` TUI center on the terminal, not on the tab-content area.

### Modified Capabilities
<!-- None: no existing spec requirement changes. -->

## Impact

- `agentic-coding/src/tui/dash/ui/GenericModal.tsx` — wrap overlay in `<Portal>`.
- `agentic-coding/src/tui/dash/devenv-ui/components/GenericModal.tsx` — same change.
- No new dependencies (`Portal` ships in `@opentui/solid` 0.4.2, already installed).
- No engine, CLI, or data changes; the modal layout fix is TUI-only.
