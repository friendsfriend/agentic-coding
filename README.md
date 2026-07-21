# Agentic coding setup

Pi agent assets, Herdr workflow configuration, OpenCode assets, OpenSpec history, workflow dashboard, and OTEL viewer.

## Dependencies

- [Pi](https://github.com/badlogic/pi-mono) and `pi install npm:@ogulcancelik/pi-herdr`
- [Herdr](https://github.com/ogulcancelik/herdr) HEAD
- [Bun](https://bun.sh/) for `agent-dash` and `otel-tui`
- `opencode` only when using OpenCode assets

## Install

```bash
./scripts/stow.sh
./scripts/install-tui.sh           # agent-dash + otel-tui
./scripts/install-agent-dash.sh    # agent-dash only
./scripts/install-otel-tui.sh      # otel-tui only
```

`stow.sh` creates file-level links for `pi/` → `~/.pi/agent/`, `herdr/` → `~/.config/herdr/`, and `opencode/` → `~/.config/opencode/`. Local target files remain real files and are never overwritten.

## TUI development

```bash
cd agent-dash
bun install
bun run dev

cd ../otel-tui
bun install
bun run dev -- --repo /path/to/repo
bun run type-check
bun test
```

`agent-dash` manages Herdr workflows. `otel-tui` receives OTLP HTTP JSON at loopback `127.0.0.1:4318`. Herdr keeps local `traces.jsonl` history and exports best-effort spans to standard `OTEL_EXPORTER_OTLP_*` trace endpoints.

Start managed workflow inside Herdr:

```bash
herdr-manager
```

## Testing

```bash
./scripts/test-workflow.sh
./scripts/test-plugin-system.sh
./scripts/test-herdr-manager.sh
```
