# Agentic coding setup

Pi agent assets, Herdr workflow configuration, OpenCode assets, OpenSpec history, and the merged `agentic-coding` TUI (workflow dashboard + observability).

## Dependencies

- [Pi](https://github.com/badlogic/pi-mono) and `pi install npm:@ogulcancelik/pi-herdr`
- [Herdr](https://github.com/ogulcancelik/herdr) HEAD
- [Bun](https://bun.sh/) for the `agentic-coding` engine + TUI
- `opencode` only when using OpenCode assets

## Install

```bash
./scripts/install.sh          # stow assets + build and link the agentic-coding binary
./scripts/test-workflow.sh    # unit + characterization tests (agentic-coding package)
./scripts/test-herdr-workflow.sh  # end-to-end workflow through the real CLI
./scripts/test-herdr-manager.sh   # herdr-manager shim smoke test
```

`install.sh` runs `stow.sh` (file-level links for `pi/` → `~/.pi/agent/`, `herdr/` → `~/.config/herdr/`, `opencode/` → `~/.config/opencode/`), then compiles the **single self-contained `agentic-coding` executable** (`bun build --compile`, engine + TUI in one binary, `@opentui/solid` JSX plugin, `HERDR_AGENT_DEF_DIR` injected at compile time) and links it to `~/.local/bin/agentic-coding`. Local target files remain real files and are never overwritten.

Manual rebuild: `bun run --cwd agentic-coding build` → `agentic-coding/dist/agentic-coding` (+ `agentic-coding-grpc-sidecar` for the OTLP gRPC receiver). The dev shim `agentic-coding/bin/agentic-coding` runs the sources via `bun` (no compile) for development.

The `herdr-workflow` command agents call is a thin shim (`pi/bin/herdr-workflow`) that forwards to `agentic-coding workflow`; installing `agentic-coding` is required for any workflow to run.

## `agentic-coding` surfaces

One binary, four surfaces:

| Surface | Invocation | Purpose |
|---|---|---|
| `workflow` | `agentic-coding workflow <command>` | Workflow engine (CLI) |
| `dash` | `agentic-coding dash --repo PATH --change ID` | Per-workflow dashboard + observability TUI (run in the workflow's dashboard pane) |
| `home` | `agentic-coding home` | Workflow list + observability TUI (long-lived launcher) |
| `manager` | `agentic-coding manager` | Alias for `home`; what `herdr-manager` execs |

The TUI is one process with a single TabBar: **Workflow** (dashboard/home) and **Observability** (traces/logs/metrics/topology). Switch with `Ctrl+1` / `Ctrl+2`. The OTLP receiver lives at shell level, so spans keep flowing while the workflow tab is active — `home`/`manager` binds `127.0.0.1:4318` by default; per-workflow `dash` panes don't (the manager instance owns the receiver).

```bash
agentic-coding --help                    # list surfaces
agentic-coding workflow --help           # list workflow commands
agentic-coding workflow start --help     # usage for one command
agentic-coding dash --profile test       # interactive dummy-data dashboard
agentic-coding home --json               # dump workflow list as JSON (headless)
```

Workflow commands (`--repo <path> --change <id>` required on all but `projects`/`config`):

| Command | Flags | Purpose |
|---|---|---|
| `projects` | — | List discovered repositories under the configured projects root. |
| `config` | — | Print the resolved workflow config as JSON. |
| `start` | `--mode <worktree\|checkout>` (required), `--workflow-type <standard\|direct-apply\|no-openspec>`, `--task`, `--ticket`, `--worker` | Create branch/worktree, Herdr workspace, launch first-phase role(s). |
| `planner` | — | Restart the planner role during `explore`. |
| `apply` | — | Run the plan-quality gate, start the worker role. |
| `verify` | — | Re-enter the verify phase (e.g. after a fix round). |
| `dispatch-verifiers` | — | Start the review-tier verifier roles for the current round. |
| `finish-review` | — | Consolidate verifier verdicts and transition out of verify (also: developer review approval). |
| `verification-result` | `--role <name>` (required) | Record one verifier role's pass/fail verdict. |
| `archive` | — | Start the archive role after developer approval; then commit/push. |
| `close` | — | Tear down panes/tabs after archive completes. |
| `status` | — | Print the current workflow state (read from the sqlite store). |
| `git-operations` | — | Stage/commit/push the finished change without an agent. |
| `phase <phase>` | — | Force-set the recorded phase (no transition logic). |
| `override-phase <phase>` | — | Operator escape hatch: jump to an arbitrary phase. |
| `preflight-archive` | — | Validate archive preconditions without starting archive. |
| `set-return` | `--workspace <id>` (required) | Record the Herdr workspace to focus once closed. |
| `message <text>` | `--from <role> --to <role>` (required) | Deliver an inter-role message (e.g. `PLAN_REJECTED`). |
| `plugin list\|install <source>\|install-local <path>` | `[--worker] [--planner]` | List/install Pi extensions, optionally scoped to roles. |

Subcommand names and flags are a frozen contract (agent skills/prompts and the dashboard invoke them literally); see `test/characterization.test.ts`.

## Verification flow

`verify` → triage tiers the diff → selected verifiers report JSONL findings → when **every dispatched verifier has reported**, `finish-review` consolidates deterministically (no verifier doubles as coordinator). Any FAIL round fails fast to a fix round. State lives in `<repo>/.herdr-workflow/herdr.db` (one row per change, `bun:sqlite`); legacy `state.json` files migrate on first load. Review artifacts (`request.md`, `reviews/`, traces) remain plain files.

## TUI development

```bash
cd agentic-coding
bun install
bun run dev:ui          # home mode: workflow list + observability
bun run dev:ui-dash     # dash mode: requires --repo/--change or --profile test
bun run type-check
bun test
```

Herdr keeps local `traces.jsonl` history and exports best-effort spans to standard `OTEL_EXPORTER_OTLP_*` trace endpoints. The merged TUI receives OTLP HTTP JSON at loopback `127.0.0.1:4318` (home/manager mode).

Start managed workflow inside Herdr:

```bash
herdr-manager
```
