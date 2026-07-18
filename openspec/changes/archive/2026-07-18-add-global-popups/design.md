# Design: add-global-popups

## Scope

Config-only. Add two popup keybindings to herdr config, rebind two conflicting defaults.

## Config Changes in `~/.config/herdr/config.toml`

### Rebind conflicting defaults

```toml
[keys]
prefix = "ctrl+g"
goto = "prefix+shift+g"
edit_scrollback = "prefix+shift+e"
```

### Add popup commands

```toml
[[keys.command]]
key = "prefix+g"
type = "popup"
command = "lazygit"
width = "80%"
height = "80%"

[[keys.command]]
key = "prefix+e"
type = "popup"
command = "nvim"
width = "80%"
height = "80%"
```

## Behavior

- Popup opens as session-modal terminal overlay (no tab layout change)
- popup closes when command exits
- Width/height at 80% of terminal dimensions leave visibility of underlying layout
- User can interact with lazygit/nvim, quit to return to herdr

## Conflict Resolution

| Shortcut | Default | Rebound to |
|---|---|---|
| `prefix+g` | goto → lazygit | goto → `prefix+shift+g` |
| `prefix+e` | edit_scrollback → nvim | edit_scrollback → `prefix+shift+e` |

## Validation

- `herdr config check` passes after edit
- `prefix+g` opens lazygit popup
- `prefix+e` opens nvim popup
- `prefix+shift+g` invokes goto
- `prefix+shift+e` invokes edit_scrollback
