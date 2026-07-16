# Agentic coding setup

Pi agent assets, Herdr workflow configuration, OpenCode assets, OpenSpec history, and agent dashboard.

## Install

```bash
./scripts/stow.sh
./scripts/install-agent-dash.sh
```

`stow.sh` creates file-level links for:

- `pi/` → `~/.pi/agent/`
- `herdr/` → `~/.config/herdr/`
- `opencode/` → `~/.config/opencode/`

Local files in these target directories remain real files and are never overwritten.

`install-agent-dash.sh` builds and installs `agent-dash` into `~/.local/bin`.

Start managed workflow inside Herdr:

```bash
herdr-manager
```
