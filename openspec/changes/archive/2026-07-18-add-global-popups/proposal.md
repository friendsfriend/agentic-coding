## Why

User wants global popup shortcuts in herdr: prefix+g → lazygit, prefix+e → nvim. Herdr already supports popup keybindings natively via `[[keys.command]]` in `~/.config/herdr/config.toml`. Default `prefix+g` (goto) and `prefix+e` (edit_scrollback) conflict and need rebinding.

This is a config-only change — no code, no agent changes.

## What Changes

- Add `[[keys.command]]` entries in `~/.config/herdr/config.toml` for lazygit and nvim popups
- Rebind `goto` to `prefix+shift+g` and `edit_scrollback` to `prefix+shift+e` to free `prefix+g` and `prefix+e`

## Capabilities

### New Capabilities
- `global-popup-lazygit`: `prefix+g` opens a session-modal lazygit popup
- `global-popup-nvim`: `prefix+e` opens a session-modal nvim popup

### Modified Capabilities
- `goto` moves from `prefix+g` to `prefix+shift+g`
- `edit_scrollback` moves from `prefix+e` to `prefix+shift+e`

## Impact

- Only `~/.config/herdr/config.toml` changes. No source code changes.
- User must reload herdr config after change (`herdr server reload-config` or restart).
