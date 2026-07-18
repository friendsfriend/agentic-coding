# Agentic coding setup

Pi agent assets, Herdr workflow configuration, OpenCode assets, OpenSpec history, and agent dashboard.

## Dependencies

- [Pi](https://github.com/badlogic/pi-mono) and `pi install npm:@ogulcancelik/pi-herdr`
- [Herdr](https://github.com/ogulcancelik/herdr) HEAD with `agent start`/`agent prompt` support
- [Bun](https://bun.sh/) for `agent-dash`
- `opencode` only when using OpenCode assets

## Install

```bash
./scripts/stow.sh
./scripts/install-tui.sh           # agent-dash + otel-tui
./scripts/install-agent-dash.sh    # agent-dash only
./scripts/install-otel-tui.sh      # otel-tui only
```

`stow.sh` creates file-level links for:

- `pi/` → `~/.pi/agent/`
- `herdr/` → `~/.config/herdr/`
- `opencode/` → `~/.config/opencode/`

Local files in these target directories remain real files and are never overwritten.

`install-tui.sh` builds and installs both binaries. Specialized scripts build and install only their named TUI into `~/.local/bin`.

## TUI development

```bash
cd agent-dash
bun install
bun run dev           # run TUI from source
bun run type-check
bun test
bun run build:single  # build current OS/architecture
bun run install:bin   # build current target and copy both binaries to ~/.local/bin

otel-tui --file /path/to/.herdr-workflow/change/traces.jsonl
```

`bun run build` builds all supported platform variants. Build output is under `agent-dash/dist/`; it is ignored by Git. `otel-tui` accepts OTLP HTTP JSON at loopback `127.0.0.1:4318/v1/traces`; use only protected networks for `--host` non-loopback because receiver has no authentication. Herdr keeps local `traces.jsonl` history and sends best-effort exports to standard `OTEL_EXPORTER_OTLP_*` trace endpoints. Re-run `bun run install:bin` after TUI changes before using `herdr-manager`.

Start managed workflow inside Herdr:

```bash
herdr-manager
```
