## Why

Copying a TUI selection to the system clipboard fails on Linux. The two clipboard helpers (`src/tui/dash/clipboard.ts`, used by the dash TUI and the shared `src/tui/index.tsx` shell, and `src/tui/otel/app/clipboard.ts`, used by the otel/trace TUI) only ever shell out to `xclip` or `xsel`. Neither binary is present on a plain Wayland compositor (e.g. Hyprland/omarchy), where the standard clipboard tool is `wl-copy`, so both helpers silently fail there. On top of that, the dash TUI's two selection-copy key handlers (Ctrl+C and Cmd/Meta+C in `src/tui/dash/App.tsx`) always show a "Selection copied" success toast without checking the helper's return value, so a failed copy is reported to the user as a success with no way to tell copying actually didn't happen.

## What Changes

- Add Wayland clipboard support (`wl-copy`) to the Linux clipboard command fallback chain in both clipboard helpers, tried alongside `xclip`/`xsel`.
- Add an OSC 52 terminal escape-sequence fallback (using the already-written but currently unused `writeOsc52` in `src/tui/dash/clipboard.ts`) so copying still works when no clipboard binary is installed at all, as long as the terminal honors OSC 52 (covers headless/SSH sessions too).
- Consolidate the two near-duplicate clipboard helper modules (`src/tui/dash/clipboard.ts` and `src/tui/otel/app/clipboard.ts`) into one shared implementation so the Linux fallback chain and its tests live in one place instead of two copies that can drift.
- Fix the dash TUI's Ctrl+C and Meta+C selection-copy key handlers in `src/tui/dash/App.tsx` to check the clipboard call's result and show a "Copy failed" warning/error toast instead of an unconditional "Selection copied" success toast.
- No change to macOS (`pbcopy`) or Windows (`clip`) behavior.

## Capabilities

### New Capabilities
- `tui-clipboard-copy`: Cross-TUI clipboard copy behavior — the Linux command fallback chain (including Wayland), the OSC 52 escape-sequence fallback, and accurate success/failure user feedback for selection-copy actions in both the dash TUI and the otel/trace TUI.

### Modified Capabilities
(none — no existing spec currently documents clipboard copy behavior)

## Impact

- `src/tui/dash/clipboard.ts` and `src/tui/otel/app/clipboard.ts`: consolidated into a single shared clipboard module (exact location decided in design.md) with Linux `wl-copy` support and an OSC 52 fallback wired in.
- `src/tui/dash/App.tsx`: the two selection-copy key handlers (Ctrl+C, Meta+C) start checking the copy result and reporting failure accurately.
- `src/tui/otel/app/App.tsx`: import path updates only if the consolidated module moves; existing `copySelection` success/failure handling is already correct and unaffected in behavior.
- `src/tui/index.tsx`: import path updates only if the consolidated module moves; existing mouse-drag selection copy handling is already correct and unaffected in behavior.
- No public API, workflow schema, or CLI surface changes. No new runtime dependency — `wl-copy` and OSC 52 are optional best-effort fallbacks alongside the existing `xclip`/`xsel`/`pbcopy`/`clip` calls.
