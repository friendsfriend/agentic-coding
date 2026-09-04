## Why

The TUI ships 33 built-in themes but cannot follow the colors the user has already configured in their terminal. On omarchy the terminal palette is driven by the active omarchy theme, and on macOS by the terminal app's profile; users who switch omarchy/terminal themes want the `agentic-coding` TUI to match rather than being pinned to a bundled palette. The theme layer already has dormant plumbing for a `system` theme slot (`setSystemTheme`, the conditional `system` entry in `allThemeJson`), but nothing ever captures terminal colors to fill it.

## What Changes

- Add a startup capability that queries the controlling terminal for its configured colors — the 16 ANSI palette entries plus default foreground/background — using standard OSC escape sequences (OSC 4, OSC 10, OSC 11), with a bounded timeout and graceful failure.
- Map the captured colors into a `ThemeJson` (resolved hex values, not static ANSI indices) covering the theme keys the UI consumes (`primary`, `accent`, `error`, `warning`, `success`, `info`, `secondary`, `text`, `textMuted`, `background`, `backgroundPanel`, `backgroundElement`, `border`, `borderActive`, `borderSubtle`, and the diff/markdown/syntax keys derived from them).
- Register the captured theme via the existing `setSystemTheme` so a `system` entry appears in the theme picker only when capture succeeds; the entry is selectable and persists like any other theme name.
- Wire capture into TUI startup before the saved theme is applied, so a persisted `system` selection resolves on the next launch. When capture fails (terminal does not answer OSC queries, non-TTY/headless, `--json` mode), no `system` entry is registered and the existing fallback to the default theme applies.

## Capabilities

### New Capabilities
- `system-terminal-theme`: capturing the terminal's configured colors at TUI startup and exposing them as a selectable, persistable `system` theme that mirrors the terminal (and therefore the active omarchy/macOS terminal palette).

### Modified Capabilities
<!-- No existing spec's requirements change; the dormant setSystemTheme plumbing is unspecified today. -->

## Impact

- `agentic-coding/src/tui/dash/ui/theme.ts` — consumes a captured `ThemeJson` via the existing `setSystemTheme`; no signature change expected.
- `agentic-coding/src/tui/index.tsx` — startup path gains a terminal-color capture step before `applyDashTheme(loadDashThemeName())`, guarded to interactive TTY runs only.
- New module (e.g. `agentic-coding/src/tui/dash/ui/terminal-colors.ts`) — OSC query + response parsing + mapping to `ThemeJson`.
- No new runtime dependencies; uses Node stdin/stdout and existing theme resolution. Cross-platform (omarchy/Linux and macOS terminals that honor OSC color queries).
