# TUI restoration: the original UI on the native backend

Status: **governing direction** (developer decision, supersedes every earlier
TUI interaction rule in `tui-architecture.md`, `tui-parity.md`,
`client-server-interface.md` and the README where they conflict).

## Goal

The v2 TUI looks, feels and is operated exactly like the original agentic-coding
TUI. Same layout, styling, colors, views, modals, keybindings, footer/help,
mouse behavior and interaction paths. The developer liked the original UI; the
target is that same feeling.

Only two things differ from v1:

1. **Agent handling** — pi-durable orchestrator, native child sessions and
   native skill tasks instead of the v1 workflow engine.
2. **Backend execution** — every user action is executed by the native v2
   backend through the authenticated typed gateway (`/api/client`), with the
   native ownership, revision and cleanup fences, instead of the v1 devenv
   server/runtime.

Everything the user sees and touches is the original.

## What was wrong

The earlier v2 TUI turned every page into a prompt with prepared `/commands`:
lists only staged unsent commands, writes needed manually typed
`approve:<digest>`, settings/wiki were JSON editors driven from the prompt, and
OpenCode/Pi were reduced to chat-only transcripts. That is a redesign, not the
original UI, and is retired.

## Rules

- **Transcript views only where v1 had them.** The Orchestrator, Pi Durable and
  native child sessions are transcript views with a prompt. Slash commands stay
  available there as an optional power-user path. No other page has a prompt.
- **Lists act directly.** Every v1 list action works from the list with the v1
  key and the v1 interaction path: select a row, press the key, the action runs
  (with the same pickers/confirm dialogs v1 showed). No command prefill.
- **No separate approval step for user-initiated actions.** A direct user action
  in the UI (key press, menu choice, `y` in a v1 confirm dialog) *is* the
  developer's approval. The client calls the gateway, and the backend records
  that interactive approval instead of opening a separate review. Agent-
  initiated actions (orchestrator/child tool calls) keep their human reviews.
  Typing `approve:<digest>` is never required in the UI.
- **Native fences stay.** Ownership, exact revisions, no adoption, quarantine on
  uncertainty, HTTPS-except-loopback and secret references remain enforced by the
  backend. A refusal is shown the way v1 showed errors (error dialog /
  notification), not as a prompt message.
- **OpenCode and Pi are embedded terminals,** exactly as v1: the real `opencode`
  and `pi` programs in a PTY rendered inside the shell, one long-lived process
  each, hidden (not stopped) on navigation, stopped on shell shutdown.
- **Port, don't import.** v1 presentation code (`agentic-coding/src/tui`,
  `agentic-coding/packages/ui`, `agentic-coding/packages/devenv/cli/src/tui`) is
  copied and adapted into `src/tui`. No runtime import of v1 modules or
  `@agentic-coding/ui`. v1 stores are re-pointed at the v2 gateway.
- Sidebar hierarchy stays OpenCode → Pi → Pi Durable → Orchestrator → native
  children. Never nest `<text>`.

## Surface inventory (v1 → v2 source of data/actions)

### Environments (v1 devenv TUI)
- Tabs: Applications, Infrastructure, Libraries, Scripts/Tasks, Kubernetes,
  UI-test/stages, Slots — with per-row live status, git column, search `/`,
  filter `F`, sort `O`.
- List keys: `Enter` detail, `s`/`S`/`R` start (profile/target picker)/stop/
  restart, `b`/`t` build/test (toggle logs while running), `l` logs, `L` action
  history, `r` refresh, `m`/`M` change requests, `i`/`I` issues, `c` providers,
  `p`/`P`/`f` git pull/push/fetch, `g` branch selector, `e`/`E` editor, `G`
  lazygit, `d` lazydocker, `9` k9s, `W` worktrees, `x` force release, `+`/`-`
  add/remove.
- App detail view with info, endpoints, CPU/memory charts and history.
- Log modal (live follow, search, copy), action-run modal (steps/log panels).
- Kubernetes cluster view: create/delete/recreate/refresh/export kubeconfig.
- Backend: `environment.action` (run/build/test) plus new native operations
  where v2 lacks them: stop/restart of an owned run, live log stream, container
  stats, git operations, cluster lifecycle.

### Providers (v1 issue / change-request views)
- Issue list/detail/timeline, scope picker, labels/assignees/comment/close.
- Change-request list/detail, approve toggle, rebase, changed files + diff,
  discussions (reply/resolve), pipeline jobs (logs/retry/cancel), test results,
  linked issues.
- Backend: `providers.inspect` reads and `providers.preview/apply` writes; the
  UI confirm dialog supplies the approval.

### Settings, providers config, profiles/models, wiki, schedules, observability
- v1 settings section views, credential/number editors, theme picker, provider
  connect modal, profile picker, wiki and schedule views, observability views —
  form/list based as in v1, saving through the existing native settings/wiki/
  schedule gateway methods without typed digests.

### Sessions
- Orchestrator, Pi Durable and child transcripts keep the restored v1
  transcript/tool presentation, prompt and sidebars (already restored).
- OpenCode/Pi: v1 embedded terminal views.

## Order of work

1. Environments (tables, direct actions, detail with stats, log/action modals,
   slots, Kubernetes cluster).
2. Providers (issues, change requests and all sub-views).
3. Settings, provider config, profiles/models, wiki, schedules, then
   OpenCode/Pi embedded terminals.

## Testing

Unchanged agreement: few functional tests at the authenticated public boundary
(e.g. a direct user action executes without a separate review; an agent action
still requires one). No renderer, mount, snapshot, presenter, helper or
navigation-matrix tests. Visual/terminal parity is verified manually by the
developer against v1.

## Progress: environments restored (step 1)

- `src/tui/devenv/` is the v1 devenv TUI ported by copy: `ui/` (packages/ui),
  `types/` (devenv/types), `app/` (devenv/cli/src/tui), `core/` (the client
  facade, logger, slot/stage/domain-event types). Imports are rewritten to
  relative paths; no v1 module or `@agentic-coding/ui` is imported at runtime.
  The logger writes under v2's state dir; preferences use v2's config dir.
- `core/client.ts` keeps v1's `DevEnvClient` method signatures, but every method
  dispatches by name to a `DevEnvBackend`. `gateway-backend.ts` is the only v2
  backend:
  - apps/infrastructure/libraries, status, slots and action definitions are
    projected from the authenticated `state.read` snapshot;
  - `startActionRun`/`runApp`/`buildApp`/`testApp`/`startApp` call
    `environment.action` (interactive approval: no review gate);
  - stop/cancel/release cancel the owning operator task (`task.cancel`) and
    refuse runs held by any other task;
  - logs read `environment.inspect logs`; native runs are presented as v1
    action-run events, so the original action modal renders them;
  - every other v1 method rejects with a visible "not available in v2 yet"
    error dialog. Nothing falls back to a shell, Docker or a v1 server.
- `EnvironmentsFeature.tsx` mounts v1's `TUIApp` in embedded mode inside the v2
  shell, registers v1's keymap fields and gates its layers with
  `shell.feature`. The environments page has no prompt; the old
  `EnvironmentsMenu`/`EnvironmentWorkbench`/`DiagnosticsComposer` are removed.
- Test: `test/operator-environment.test.ts` "the restored v1 environments
  client runs, reads and stops a native run through the gateway".
- Still missing native backends (shown as v1 error dialogs until added): git
  pull/push/fetch/branches/worktrees, container restart/stats streams,
  Kubernetes cluster status/lifecycle beyond the implicit devenv entry, scripts,
  providers/issues/change requests inside the environments views, action
  history beyond the retained native runs.
