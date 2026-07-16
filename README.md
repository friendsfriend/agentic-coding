# Agentic coding setup

Pi agent assets, Herdr workflow configuration, OpenCode assets, OpenSpec history, and agent dashboard.

## Dependencies

- [Pi](https://github.com/badlogic/pi-mono) and `pi install npm:@ogulcancelik/pi-herdr`
- [Herdr](https://github.com/ogulcan/Herdr)
- [Bun](https://bun.sh/) for `agent-dash`
- `opencode` only when using OpenCode assets

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

`install-agent-dash.sh` installs locked Bun dependencies, builds current platform binary, then installs `agent-dash` into `~/.local/bin`.

## TUI development

```bash
cd agent-dash
bun install
bun run dev           # run TUI from source
bun run type-check
bun test
bun run build:single  # build current OS/architecture
bun run install:bin   # build current target and copy to ~/.local/bin
```

`bun run build` builds all supported platform variants. Build output is under `agent-dash/dist/`; it is ignored by Git. Re-run `bun run install:bin` after TUI changes before using `herdr-manager`.

Start managed workflow inside Herdr:

```bash
herdr-manager
```
