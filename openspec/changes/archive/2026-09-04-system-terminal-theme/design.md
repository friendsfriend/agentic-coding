## Context

The TUI theme layer (`agentic-coding/src/tui/dash/ui/theme.ts`) already:
- resolves colors from a `ThemeJson` (hex strings, ANSI numeric codes, `defs` aliases, and `{dark,light}` pairs);
- exposes `setSystemTheme(theme: ThemeJson | undefined)` and, in `allThemeJson()`, conditionally includes a `system` entry when a system theme is registered;
- rebuilds `themeNames` via `syncThemeNames()` so the picker (`ThemePickerModal`, `App.tsx`) shows whatever is registered;
- persists the selected name through `theme-settings.ts` (`loadThemeName` falls back to `catppuccin` when the saved name is not currently in `themeNames`).

The gap: nothing captures terminal colors and calls `setSystemTheme`, so the `system` slot is never populated. Startup applies the saved theme at `index.tsx:274` (`applyDashTheme(loadDashThemeName())`) immediately before `createCliRenderer`.

Terminals expose their configured colors at runtime via OSC (Operating System Command) escape queries answered on the TTY:
- OSC 4 `;<n>;?` → palette color `n` (0–15 for the ANSI set);
- OSC 10 `;?` → default foreground; OSC 11 `;?` → default background.
Responses arrive as `ESC ] <code> ; rgb:RRRR/GGGG/BBBB (BEL|ST)`, giving 16-bit-per-channel values that downscale to `#rrggbb`. This mechanism is terminal-driven, so it reflects exactly the omarchy-applied palette on Linux and the terminal profile on macOS with a single code path.

## Goals / Non-Goals

**Goals:**
- Capture the terminal's configured ANSI palette + default fg/bg at TUI startup and expose it as a selectable, persistable `system` theme.
- Reflect the active omarchy/macOS terminal colors without terminal-specific config parsing.
- Fail gracefully: when the terminal does not answer, or the run is non-interactive/headless, register no `system` entry and keep existing behavior.

**Non-Goals:**
- Live re-capture when the omarchy/terminal theme changes mid-session (captured once at startup).
- Parsing omarchy/terminal config files on disk.
- Changing the built-in themes, the picker UI structure, or the persistence file format.
- Perfect fidelity for every OSC-noncompliant terminal or multiplexer passthrough.

## Decisions

### Decision: Capture colors via OSC runtime queries, not config-file parsing
Query the controlling TTY with OSC 4/10/11 and parse the replies. Rationale: the task is "just use the colors of the terminal configuration"; OSC returns the terminal's *effective* colors, which on omarchy are the ones omarchy set and on macOS are the terminal profile's — one mechanism covers both. Alternatives considered: (a) read `~/.config/omarchy/current/theme/*` — omarchy-only, misses macOS, and duplicates terminal state; (b) rely on the theme resolver's numeric ANSI codes with the built-in `ansiToHex` — that uses a *static* standard palette and would ignore the user's actual configured colors. Rejected both.

### Decision: Store resolved hex, not ANSI indices, in the captured `ThemeJson`
Build the `ThemeJson` with concrete `#rrggbb` values parsed from the OSC replies so the theme reflects real configured colors and does not depend on `ansiToHex`. `ansiToHex` remains only as an internal fallback within the resolver for other themes.

### Decision: Map ANSI + fg/bg to semantic theme keys
Produce every key the UI reads (see `colors.ts`/`uiColors`). Baseline mapping:
- `background` ← OSC 11 (bg); `text` ← OSC 10 (fg);
- `error` ← ANSI 1; `success` ← ANSI 2; `warning` ← ANSI 3; `primary` ← ANSI 4; `accent` ← ANSI 5; `info` ← ANSI 6;
- `secondary` ← ANSI 12 (bright blue) or 5; `textMuted` ← ANSI 8 (bright black);
- `backgroundPanel`/`backgroundElement`/`border`/`borderActive`/`borderSubtle` ← derived from bg and ANSI 8 (blend toward fg for progressively lighter surfaces/borders);
- diff/markdown/syntax keys ← reuse the semantic keys above (e.g. `diffAdded`←success, `diffRemoved`←error, `syntaxKeyword`←accent) so no key resolves to a bare fallback.
The exact blend/derivation is an implementation detail owned by the worker; the requirement is that all consumed keys resolve to captured-derived colors.

### Decision: Run capture before applying the saved theme, guarded to interactive TTY
Insert capture immediately before `applyDashTheme(loadDashThemeName())` in `index.tsx`, only when `process.stdin.isTTY && process.stdout.isTTY` and not in `--json`/headless mode. This must complete before `createCliRenderer` takes over stdin: enable raw mode, write the queries, read replies until all expected codes arrive or a short timeout (~100–200 ms) elapses, then restore the prior stdin mode. On success call `setSystemTheme(built)`; then the saved-name apply resolves `system` correctly. On failure/timeout, do not register `system`.

### Decision: Reuse existing selection/persistence untouched
Because `themeNames` and the picker derive from `allThemeJson()`, and `saveThemeName`/`loadThemeName` already round-trip arbitrary names with a fallback, no picker or persistence changes are required beyond ensuring `system` is registered before load-time apply.

## Risks / Trade-offs

- [Terminal ignores OSC queries or a multiplexer swallows replies] → bounded timeout + graceful no-`system` fallback; never block startup or hang stdin.
- [Reading stdin before the renderer corrupts input state] → snapshot and restore `isRaw`/listeners; drain only our expected reply bytes; keep the read window short and synchronous relative to renderer creation.
- [Captured palette yields poor contrast (e.g. surfaces indistinguishable from bg)] → deterministic blend derivation for surfaces/borders plus documented mapping so contrast is predictable; low-contrast palettes are inherently the user's terminal choice.
- [Light vs dark terminals] → captured colors are stored as concrete hex, so the resolver's dark/light branching is bypassed; background luminance may be used to pick derivation direction but no separate light theme is authored.
- [Persisted `system` selection on a later run in a non-answering terminal] → `loadThemeName` already falls back to `catppuccin` when `system` is absent from `themeNames`.

## Migration Plan

Additive: no schema, config-format, or built-in-theme changes. Rollback is removing the capture call and the new module; persisted `system` names then fall back to the default automatically. No data migration.

## Open Questions

- Should low-contrast captured palettes trigger any adjustment, or always mirror the terminal verbatim? (Current stance: mirror verbatim; derive only surfaces/borders.)
- Live re-capture on omarchy/terminal theme change is deferred — is a manual "refresh system theme" action wanted later? (Follow-up, not in this change.)
- Should a secondary omarchy-config-file source be added for terminals that never answer OSC queries? (Deferred; OSC-only for now.)
