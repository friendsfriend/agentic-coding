# Custom Themes

DevEnv supports OpenCode-compatible TUI themes.

DevEnv also includes `system`, a generated theme based on your terminal foreground, background, and ANSI palette. Open picker with `T`, filter for `system`, and press `Enter` to save it.

## Location

Put theme files in your config directory:

```text
$DEVENV_CONFIG_DIR/themes/<theme-name>.json
```

Default path:

```text
~/.config/devenv/themes/<theme-name>.json
```

Restart DevEnv after adding or editing files. Open picker with `T`.

## Minimal theme

```json
{
  "defs": {
    "bg": "#101014",
    "fg": "#f0f0f5",
    "muted": "#8b90a8"
  },
  "theme": {
    "primary": "#7aa2f7",
    "secondary": "#bb9af7",
    "accent": "#7dcfff",
    "error": "#f7768e",
    "warning": "#e0af68",
    "success": "#9ece6a",
    "info": "#7dcfff",
    "text": "fg",
    "textMuted": "muted",
    "selectedListItemText": "bg",
    "background": "bg",
    "backgroundPanel": "#16161e",
    "backgroundElement": "#1f2335",
    "backgroundMenu": "#24283b",
    "border": "#3b4261",
    "borderActive": "#7aa2f7",
    "borderSubtle": "#292e42",
    "diffAdded": "#9ece6a",
    "diffRemoved": "#f7768e",
    "diffContext": "muted",
    "diffAddedBg": "#1d3b2a",
    "diffRemovedBg": "#3b2028",
    "diffContextBg": "#16161e"
  }
}
```

## Names

Filename becomes picker name:

```text
~/.config/devenv/themes/my-theme.json → my-theme
```

Custom names can override built-in theme names.

## Colors

Values can be:

- Hex: `#7aa2f7`
- Reference from `defs`: `fg`
- Reference to another theme key: `primary`
- ANSI number: `4`
- Dark/light object:

```json
{ "dark": "#101014", "light": "#fafafa" }
```

DevEnv currently resolves dark mode for TUI themes.

## Useful fields

Core UI:

- `primary`, `secondary`, `accent`
- `success`, `warning`, `error`, `info`
- `text`, `textMuted`, `selectedListItemText`
- `background`, `backgroundPanel`, `backgroundElement`, `backgroundMenu`
- `border`, `borderActive`, `borderSubtle`

Diff/log UI:

- `diffAdded`, `diffRemoved`, `diffContext`
- `diffAddedBg`, `diffRemovedBg`, `diffContextBg`

Markdown/syntax fields from OpenCode themes are accepted and kept for compatibility.

## Test theme

1. Create directory:

```bash
mkdir -p ~/.config/devenv/themes
```

2. Save JSON:

```bash
$EDITOR ~/.config/devenv/themes/my-theme.json
```

3. Restart DevEnv.
4. Press `T`.
5. Use `/` to filter and `j/k` to preview.
6. Press `Enter` to save.

Selected theme persists in:

```text
~/.config/devenv/tui.json
```
