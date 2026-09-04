## 1. Terminal color capture module

- [x] 1.1 Add a new module (e.g. `agentic-coding/src/tui/dash/ui/terminal-colors.ts`) that queries the controlling TTY with OSC 4 (ANSI 0–15), OSC 10 (default foreground), and OSC 11 (default background), reading replies from stdin.
- [x] 1.2 Parse `ESC ] <code> ; rgb:RRRR/GGGG/BBBB (BEL|ST)` replies into `#rrggbb` hex, tolerating both BEL and ST terminators and 8- or 16-bit-per-channel values.
- [x] 1.3 Manage stdin safely: snapshot the current raw-mode state, enable raw mode for the query window, resolve as soon as all expected codes arrive or a short timeout (~100–200 ms) elapses, then restore the prior stdin mode and remove listeners. Never leave stdin hanging.
- [x] 1.4 Guard capture to interactive runs only (`process.stdin.isTTY && process.stdout.isTTY`, skip in `--json`/headless mode); return a typed "no capture" result on timeout or non-TTY.

## 2. Map captured colors to a ThemeJson

- [x] 2.1 Build a `ThemeJson` from the captured palette using concrete hex values: `background`←bg, `text`←fg, `error`←ANSI1, `success`←ANSI2, `warning`←ANSI3, `primary`←ANSI4, `accent`←ANSI5, `info`←ANSI6, `secondary`←ANSI12/ANSI5, `textMuted`←ANSI8.
- [x] 2.2 Derive `backgroundPanel`, `backgroundElement`, `border`, `borderActive`, `borderSubtle` deterministically from the background and ANSI8/foreground (progressively lighter surfaces/borders) so surfaces and borders are distinguishable from the base background.
- [x] 2.3 Map the diff/markdown/syntax keys (e.g. `diffAdded`←success, `diffRemoved`←error, `diffContext`←textMuted, `syntaxKeyword`←accent, `syntaxString`←success, `markdownHeading`←accent) so no key consumed by `colors.ts`/`uiColors` resolves to a bare hardcoded fallback.

## 3. Wire into startup and registration

- [x] 3.1 In `agentic-coding/src/tui/index.tsx`, run capture and, on success, call `setSystemTheme(builtTheme)` immediately before `applyDashTheme(loadDashThemeName())` and before `createCliRenderer`, so a persisted `system` selection resolves at load time.
- [x] 3.2 On capture failure/timeout/non-TTY, do not register `system`; confirm `loadThemeName` still falls back to the default theme when a saved `system` name is absent from `themeNames`.
- [x] 3.3 Verify (no code change expected) that the picker and persistence pick up `system` via existing `allThemeJson()`/`themeNames`/`saveThemeName` plumbing.

## 4. Tests and validation

- [x] 4.1 Add unit tests for OSC reply parsing (BEL and ST terminators, 8/16-bit channels, malformed/partial input) and for the palette→`ThemeJson` mapping (all consumed keys resolve to captured-derived hex, not fallbacks). Prefer injecting a fake reply/reader so tests do not depend on a real TTY.
- [x] 4.2 Add a test that a built system theme, once registered via `setSystemTheme`, appears in `themeNames`, is selectable via `setActiveThemeName("system")`, and resolves `themeColor("background")`/`themeColor("text")` to the captured values; and that with no system theme registered, `system` is absent and selection falls back to the default.
- [x] 4.3 Update `agentic-coding/test/otel/theme.test.ts` if its hardcoded `themeNames` length assertion (currently 33, built-ins only) is affected; ensure it still reflects built-in-only state when no system theme is registered.
- [x] 4.4 Run focused checks from `agentic-coding/`: `bun run type-check`, `bun run lint`, and the theme-related tests (`bun test test/otel/theme.test.ts` plus any new test file added in 4.1–4.2). Do not run the full repository suite.
