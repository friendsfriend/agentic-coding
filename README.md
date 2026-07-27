# Agentic coding setup

Pi agent assets, Herdr workflow configuration, OpenCode assets, OpenSpec history, workflow dashboard, and OTEL viewer.

## Dependencies

- [Pi](https://github.com/badlogic/pi-mono) and `pi install npm:@ogulcancelik/pi-herdr`
- [Herdr](https://github.com/ogulcancelik/herdr) HEAD
- [Bun](https://bun.sh/) for `agent-dash`, `otel-tui`, and the `agentic-coding` workflow engine
- `opencode` only when using OpenCode assets

## Install

```bash
./scripts/stow.sh
./scripts/install-tui.sh              # agent-dash + otel-tui + agentic-coding
./scripts/install-agent-dash.sh       # agent-dash only
./scripts/install-otel-tui.sh         # otel-tui only
./scripts/install-agentic-coding.sh   # agentic-coding (workflow engine) only
```

The `herdr-workflow` command agents call is a thin shim (`pi/bin/herdr-workflow`) that forwards to `agentic-coding workflow`; installing `agentic-coding` is required for any workflow to run.

`stow.sh` creates file-level links for `pi/` → `~/.pi/agent/`, `herdr/` → `~/.config/herdr/`, and `opencode/` → `~/.config/opencode/`. Local target files remain real files and are never overwritten.

## `agentic-coding` usage

Since `consolidate-workflow-to-typescript`, the workflow engine is TypeScript, invoked as `agentic-coding <surface> <command> [flags]`. `workflow` is the only surface today. `herdr-workflow <command> [flags]` (agent-facing) is a shim for `agentic-coding workflow <command> [flags]` — same commands and flags, either invocation works.

```bash
agentic-coding --help                    # list surfaces
agentic-coding workflow --help           # list workflow commands
agentic-coding workflow start --help     # usage for one command
```

Commands (`--repo <path> --change <id>` required on all but `projects`/`config`):

| Command | Flags | Purpose |
|---|---|---|
| `projects` | — | List discovered repositories under the configured projects root. |
| `config` | — | Print the resolved workflow config as JSON. |
| `start` | `--mode <worktree\|checkout>` (required), `--workflow-type <standard\|direct-apply\|no-openspec>`, `--task`, `--ticket`, `--worker` | Create branch/worktree, Herdr workspace, launch first-phase role(s). |
| `planner` | — | Restart the planner role during `explore`. |
| `apply` | — | Run the plan-quality gate, start the worker role. |
| `verify` | — | Re-enter the verify phase (e.g. after a fix round). |
| `dispatch-verifiers` | — | Start the review-tier verifier roles for the current round. |
| `finish-review` | — | Consolidate verifier verdicts, transition out of verify. |
| `archive` | — | Start the archive role after developer approval. |
| `close` | — | Tear down panes/tabs after archive completes. |
| `status` | — | Print the current `state.json`. |
| `git-operations` | — | Start the git-operations role (push/PR). |
| `phase <phase>` | — | Force-set the recorded phase (no transition logic). |
| `override-phase <phase>` | — | Operator escape hatch: jump to an arbitrary phase. |
| `preflight-archive` | — | Validate archive preconditions without starting archive. |
| `set-return` | `--workspace <id>` (required) | Record the Herdr workspace to focus once closed. |
| `verification-result` | `--role <name>` (required) | Record one verifier role's pass/fail verdict. |
| `message <text>` | `--from <role> --to <role>` (required) | Deliver an inter-role message (e.g. `PLAN_REJECTED`). |
| `plugin list\|install <source>\|install-local <path>` | `[--worker] [--planner]` | List/install Pi extensions, optionally scoped to roles. |

Subcommand names and flags are a frozen contract (agent skills/prompts and the dashboard invoke them literally); see `test/characterization.test.ts`.

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
./scripts/test-herdr-manager.sh
```
