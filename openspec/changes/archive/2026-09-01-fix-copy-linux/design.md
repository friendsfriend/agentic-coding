## Context

Two independent, drifted clipboard helpers exist today, both Linux-only via `xclip`/`xsel`:

- `src/tui/dash/clipboard.ts` exports `copyToClipboard(text)` (tries `xclip` then `xsel`, returns boolean) and an unused `writeOsc52(text)`. Consumed by `src/tui/dash/App.tsx` (two call sites that ignore the boolean) and `src/tui/index.tsx` (one call site that already checks the boolean correctly).
- `src/tui/otel/app/clipboard.ts` exports `copyText(text)` with the same `xclip`/`xsel`-only logic inlined differently, no OSC 52 fallback. Consumed by `src/tui/otel/app/App.tsx`'s `copySelection`, which already checks the boolean correctly.

Root cause of "copy doesn't work on Linux, especially the TUI": on a Wayland-only session (no `XWayland`-backed `xclip`/`xsel` installed, `wl-copy` available instead — the common case on e.g. Hyprland/omarchy), both helpers exhaust their command list and return `false` with no other fallback attempted. In the dash TUI specifically, the Ctrl+C/Meta+C handlers in `App.tsx` don't check that `false`, so the user is told "Selection copied" even though nothing was copied — the failure is invisible.

See `proposal.md` for motivation and `specs/tui-clipboard-copy/spec.md` for the behavior contract.

## Goals / Non-Goals

**Goals:**
- Make Linux clipboard copy succeed on both Wayland (`wl-copy`) and X11 (`xclip`/`xsel`) sessions.
- Provide an escape-sequence (OSC 52) fallback that works with zero installed clipboard binaries, for terminals that support it (also benefits SSH/tmux sessions where the clipboard binaries can't reach the local desktop clipboard anyway).
- Remove the duplicate clipboard implementation so the Linux fallback chain has one place to fix/test instead of two.
- Make every TUI selection-copy call site report failure honestly.

**Non-Goals:**
- Detecting terminal OSC 52 support ahead of time; the fallback is fire-and-forget best-effort like the existing OSC 52 write patterns already have to be.
- Changing macOS or Windows clipboard behavior.
- Adding a clipboard-read (paste-from-app) capability; this change is copy-out only, matching current scope.

## Decisions

**Consolidate into one shared module at `src/tui/clipboard.ts`.**
Both `src/tui/dash/App.tsx` and `src/tui/otel/app/App.tsx`, plus `src/tui/index.tsx`, sit under `src/tui/`, so a sibling module at that level is reachable from all three without a new package boundary. The module exports:
- `copyToClipboard(text: string): boolean` — the platform command fallback chain, now including `wl-copy` on Linux, falling back to `writeOsc52` (and reporting `true`) when every command attempt fails.
- `writeOsc52(text: string): void` — kept as an explicit, separately callable primitive since it's also a reasonable thing to reach for directly (e.g. for a caller that wants to force the escape-sequence path); not exported for reuse beyond the clipboard module's own fallback in this change.

`src/tui/dash/clipboard.ts` and `src/tui/otel/app/clipboard.ts` are deleted; their imports are repointed at `src/tui/clipboard.ts`. `copyText` is not kept as a separate name — `src/tui/otel/app/App.tsx` switches to importing `copyToClipboard` for one behavior instead of two functions doing the same thing under different names.

Alternative considered: keep two modules and patch the Linux command list in both. Rejected — it's the duplication that let the two implementations drift (one has OSC 52 dead code, the other doesn't; the fallback lists were already slightly different) and it doubles the surface a future platform fix has to touch.

**Command fallback order: `wl-copy`, `xclip`, `xsel`, then OSC 52.**
`wl-copy` first because a Wayland compositor session is the case this bug report is about and `wl-copy` fails fast (no XWayland to spin up) when absent. `xclip`/`xsel` keep their existing relative order for X11 sessions. OSC 52 is the last resort, tried only when every command attempt throws (missing binary or non-zero exit) — it works even with no clipboard tool installed, so it can't itself "fail" in a way this change needs to detect; the outcome of the whole `copyToClipboard` call is `true` once the escape sequence is written.

Alternative considered: pick the single tool by inspecting `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE` instead of trying all of them. Rejected as unnecessary complexity — trying each command and catching the failure (already the existing pattern) is simpler and also covers mixed/XWayland sessions where either tool might work.

**Selection-copy notification fix stays call-site-local.**
`src/tui/dash/App.tsx`'s two handlers change from `copyToClipboard(selection); notify("Selection copied", "success")` to checking the return value and branching to a failure notification, matching the pattern already used correctly in `src/tui/index.tsx` and `src/tui/otel/app/App.tsx`. No new abstraction needed since only two call sites are affected and the correct pattern already exists elsewhere in the codebase to mirror.

## Risks / Trade-offs

- [OSC 52 fallback reports success without confirming the terminal actually applied it, since terminals don't ack OSC 52] → Accepted: this matches the proposal's "best-effort" framing and the pre-existing dead `writeOsc52` code already had no ack mechanism; a false "succeeded" notification in a non-supporting terminal is a smaller regression than the current false "succeeded" notification on every Wayland-only failure.
- [Deleting `src/tui/otel/app/clipboard.ts` and `src/tui/dash/clipboard.ts` changes import paths in three files] → Mitigation: update all three import sites (`src/tui/dash/App.tsx`, `src/tui/otel/app/App.tsx`, `src/tui/index.tsx`) in the same change; covered explicitly in tasks.md.
- [`wl-copy` invocation semantics differ slightly from `xclip`/`xsel` (e.g. it can background itself to keep the selection alive)] → Mitigation: pass text via stdin and let the call be synchronous like the existing `execFileSync` calls for other tools, matching the pattern already used for `pbcopy`/`clip`; verified in a unit test that stubs the process/exec layer rather than requiring a real Wayland session in CI.

## Migration Plan

Single internal refactor + bugfix, no data migration. Land the consolidated `src/tui/clipboard.ts`, repoint the three import sites, delete the two old files, and update/relocate their existing usages' tests. No rollback concerns beyond a normal revert since there is no persisted state or external API involved.
