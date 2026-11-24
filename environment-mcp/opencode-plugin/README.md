# OpenCode TUI plugin

The app-centric OpenCode 2.0.22 TUI for `environment-mcp`. It presents the
configured environments — applications, libraries, infrastructure, services,
receipts, logs and telemetry — rather than the agent's MCP tool list.

It uses the same authenticated loopback capability API as the standalone UI. It
does not construct an MCP server, listener, journal, runtime adapter or approval
gate, and it has no plugin-local action table.

## Install

The plugin is a local package beside the server:

```sh
mkdir -p ~/.config/opencode/plugins
ln -sfn "$PWD/opencode-plugin" ~/.config/opencode/plugins/environment-mcp
opencode plugin list
```

OpenCode discovers `<config>/plugins/<directory>` automatically and hot-reloads
the source; there is no build step for local use.

Open it with any of:

- the clickable **Environment** chip in the home footer
- `/environment` or `/env`
- `<leader>v` (the default leader is `ctrl+x`, so `ctrl+x v`)
- the command palette (`ctrl+p`) entry **Environment**

## Screens

- **Applications / Libraries / Infrastructure** — the configured environment
  inventory, glyph target summaries (`⚒` build, `✓` test, `▶` run), git branch
  and modified/added/deleted counts with ahead/behind, and current run status
  with owned-resource count. An authenticated SSE stream invalidates
  status/history/git while the panel is open; 15s/30s reconciliation polling is
  the fallback.
- **Application detail** — kind, repository, git state, current status, defaults,
  targets, owned resources, recent receipts, and the action keys. `c` opens the
  changed-files list.
- **Changes / Diff** — bounded changed paths with status glyphs, stage/worktree
  flags and rename origins; `Enter` opens a bounded unified diff. Binary,
  symlink, directory and invalid paths are refused with a clear note.
- **Target picker** — the exact configured target/profile for build, test or run.
- **Operation** — the running or settled execution receipt, subject,
  digest/revision, live build steps and per-step logs.
- **History** — operation receipts with safe app/target/action attribution.
- **Services** — configured service bindings and controller-wide shared state.
- **Logs / Telemetry** — owned logs and captured OTLP logs/traces for the
  selected application.

## Actions

| Key | Action |
| --- | --- |
| `b` | Prepare a build review |
| `s` | Prepare a start/run review |
| `t` | Prepare a test review |
| `S` | Stop owned resources for the selected app |
| `l` | Read owned logs |
| `L` | Open operation history |
| `e` | Read telemetry |
| `r` | Refresh the current surface |
| `Esc` | Back / close |
| `?` | Full keybind help |

Build, test and run execute directly:

1. The plugin calls `env_execute` with the exact app/target and a fresh request id.
2. The operation is admitted and dispatched in one step.
3. `env_wait` observes the settled receipt; `r` refreshes if it is still running.

Stop is owned-only and does not touch borrowed/shared services. There is no
approval surface.

## Filtering

While the application filter is focused, `↑/↓` moves the filtered result
selection. `Enter` returns focus to the list without opening anything; the
normal arrows/`j/k` then navigate and `Enter` opens the selected application.
`Esc` clears the filter.

## Configuration

Defaults:

| Setting | Default |
| --- | --- |
| URL | `http://127.0.0.1:38471` |
| Token file | `~/.config/environment-mcp/client-token` |

Override with `ENVIRONMENT_MCP_URL` / `ENVIRONMENT_MCP_TOKEN_FILE`, or pass
`url` / `tokenFile` plugin options through an explicit `cli.json` entry.

## Current backend limits

The environment-mcp capability registry currently exposes the execution
inventory, direct execution/wait, owned stop, logs, telemetry, services and
receipts. It does not yet expose git branch/fetch/worktree operations,
container stats, Kubernetes cluster inspection, provider change requests /
issues / pipelines, or app/task CRUD. Those screens are not claimed here; they
require new capabilities before they can be added to this UI.

The table and detail only read metadata. `env_list` still carries executable
descriptors for the agent; this UI never renders them.

## Checks

```sh
bun install
bun run type-check
bun test
```

From the server package, `bun run lint`, `bun run type-check` and `bun run test`
also cover the plugin sources and tests. The focused equivalents are
`bun run --cwd opencode-plugin type-check` and
`bun run --cwd opencode-plugin test`.
