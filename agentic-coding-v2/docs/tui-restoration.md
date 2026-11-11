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

## Structure correction: integrate into the existing TUI

The restored shared UI is now integrated into `src/tui/ui/`: components,
views, hooks, theme assets and the local barrel. Environment-specific stores,
actions, keymaps and gateway integration live in `src/tui/features/environments/`.
The temporary `src/tui/devenv/` tree has been removed. All consumers use the
new locations directly, with no compatibility forwarding modules. The existing
shell theme entry point is preserved. This relocation changes no backend behavior.
Validation: unfiltered type-check, Biome (zero diagnostics), and the five native
operator environment functional tests pass.

## Native stop/restart controls

- The authenticated gateway now exposes `environment.stop` with an exact
  `runId`, `revision` and `requestId`. The backend rejects non-operator owners
  and delegates atomic revision/live-authority validation and durable deduplication
  to native operator revocation. This stops the entire owning batch, including
  prerequisites; it is not per-container or per-service stop.
- Success requires a completed revocation with certain cleanup, then native task
  cancellation. Interrupted/quarantined runs and uncertain cleanup refuse instead
  of adopting resources or authorizing restart.
- The original list's stop action uses that boundary. Restart definitions are
  now offered for configured run targets. Restart stops the observed owner first,
  then admits a fresh interactive run using its original target. No restart is
  attempted after a refused/uncertain stop, and no mutations retry on reconnect.
- Functional verification extends the authenticated gateway test with stale
  revision refusal and fresh-owner restart followed by stop. Operator and idle
  suites: 7 tests passed (93 assertions). Unfiltered type-check and Biome clean.
- Shared UI remains in `src/tui/ui`; environment integration remains in
  `src/tui/features/environments`. No real app or cluster was started.

## Native git controls (v1 `f`/`p`/`P`/`g`/`W`)

- New authenticated gateway method `environment.git`, implemented by
  `src/environment/repository-git.ts` (`RepositoryGit`), covering the original
  operations: status, branches, worktrees, fetch, pull, push, checkout, create
  branch, and create/switch/remove worktree. Only configured apps/libraries in
  authorized repositories; `git()` keeps hooks, filter drivers, fsmonitor and
  prompts disabled.
- Safety over v1: pull is `fetch` + `merge --ff-only` (v1 hard-reset onto the
  remote, which could discard local commits); worktree removal is never forced;
  existing directories are never adopted. Checkout refuses uncommitted changes.
  HEAD-changing operations refuse while a native run uses that checkout. One
  mutation per repository at a time; no automatic retry. A key press in the
  TUI is the approval, so neither agents nor HTTP get this surface.
- The active linked worktree is durable native state (`v2.repository-git`).
  Direct UI runs/builds/tests execute in it, as in v1: the server derives the
  workspace from the authorized repository and the fingerprint includes it.
  A missing active worktree is refused rather than substituted.
- Gateway refusals: a new `Refusal` type (`src/server/refusal.ts`) lets curated,
  single-line, redacted diagnostics (for example git's own first error line)
  reach the original error dialog. Every other backend error stays masked.
- The original table now shows the native branch, `+a ~c -r`/`✓` git status
  and the linked-worktree marker, and `localDirectoryPath` follows the active
  worktree, so editor/lazygit launches open the right checkout.
- Functional test: authenticated gateway against a local bare origin. It
  covers fetch/branches/pull, refusal on dirty checkout, worktree creation and
  activation, a direct build executing in the linked worktree, the
  active-worktree removal refusal, switch back and removal, create-branch and
  push to origin, and an option-injection refusal. Operator suite: 6 passed.

## Live logs and container statistics (v1 log modal and app detail)

- The original "container ID" handle is the app ident. The gateway exposes
  `dockerInfo` only for a ready, running native run. The server always resolves
  the handle to that app's current live run; it never trusts a saved ID or name.
- `streamContainerLogs` follows the native run output (1 s poll, only new
  lines, honoring v1's `tail`), so the original live log modal and the detail
  log pane update in place.
- New read-only gateway method `environment.stats`. `ContainerProcess.stats()`
  verifies the live-created container identity and ownership, then runs one
  bounded `stats --no-stream` against that exact ID. Compose sums its owned
  service containers. Shell runs and unverifiable identities refuse with a
  curated message; samples are never estimated. `streamContainerStats` polls
  every 2 s and feeds the original CPU/memory sparklines.
- Functional coverage: the gateway test follows live shell output and verifies
  that stats are refused for shell. A new container test uses the synthetic
  engine for a direct UI start, gateway CPU/memory samples, an exact
  `stats --no-stream <64-hex owned id>` argv, and stop removing the container.
  Container + operator suites: 30/31 pass on a combined run; the remaining
  timing-sensitive pre-existing test passes alone (3/3).

## Kubernetes tab: native kind cluster lifecycle (v1 `s`/`S`/`R`/`r`/`e`)

- New authenticated gateway method `environment.cluster`, backed by
  `src/environment/cluster-operator.ts` (`ClusterOperator`):
  - `status`: v1's read model (kind list, `kubectl version`, nodes, pods by
    phase/namespace, Helm releases, kind node CPU/memory) over the same
    validated private connection a run uses (loopback HTTPS, config-contained
    credential files, private Helm home). Unavailable observations are
    warnings, never confirmed absence. Status never creates, imports or
    deletes anything.
  - `create` (create-if-missing plus private kubeconfig import; the same
    serialized path a run's first start takes), `delete`, `recreate` and
    `export-kubeconfig` (v1's `kind export kubeconfig` into the developer's
    KUBECONFIG / `~/.kube/config`).
- Direct key press = approval (decision 1a); agents and HTTP have no access.
  Kind lifecycle effects are serialized per cluster (`clusterLifecycle`)
  together with a run's first start. Only one operator operation runs at a
  time. Delete/recreate refuse while any native Kubernetes run on that cluster
  is not exited, and re-check under the lock. Delete also removes the private
  credential files for the deleted cluster.
- `kind create` can take minutes, longer than the gateway's 15 s call bound, so
  admission is async. Each operation is first journaled durably in
  `v2.cluster-operations` with the request id; a duplicate request id returns
  the same receipt. An issued receipt that this process no longer runs is
  reported as interrupted/uncertain, and nothing is retried. Failures carry the
  redacted one-line reason.
- TUI: `getActionDefinitions("local")` returns the original
  create/delete/recreate/export actions. Receipts become the original
  action-run events (actions modal), followed by
  `kubernetes.cluster.refreshed` / `kubernetes.cluster.deleted`, so sparklines
  and the panel update as in v1. The confirm dialogs for delete/recreate are
  unchanged.
- Earlier decision revised: "a run never deletes or recreates the cluster"
  still holds; only the developer's explicit Kubernetes-tab action can.
- Functional test (synthetic kind/kubectl/helm/docker via the authenticated
  gateway): missing status without creation; delete of a missing cluster fails
  visibly; create via the action definition; full status (version, nodes, pod
  phases, namespaces, release, node stats) without credential bytes; export
  into KUBECONFIG; recreate; delete removing private client files; exact kind
  mutation argv order. Cluster/Kubernetes/operator/protocol/gateway suites:
  38/38.

## Tasks tab: native developer task collection (v1 Scripts/Tasks)

- New authenticated gateway method `environment.tasks`, backed by
  `src/environment/task-collection.ts` (`TaskCollection`): list (v1
  tree), metadata (`--devenv-metadata`), create (v1 template, `.sh` default,
  `wx`), link (symlink to an existing file), delete, and argument history
  (durable `v2.task-args-history`, deduplicated, newest first, 50 entries).
- Location: `CONFIG_DIR/tasks/` (v1: `$DEVENV_HOME/scripts`).
  `CONFIG_DIR/scripts/` stays reserved for environment target dispatchers.
  The v1 collection is not imported automatically; link or copy tasks
  explicitly.
- Safety:
  - Paths stay relative to `tasks/`: no absolute, `..` or dot segments, and
    every existing ancestor must resolve inside the real directory.
  - Discovery never follows symlinked directories, is depth/count bounded and
    lists only executable regular files.
  - Delete unlinks a symlink and never touches its source.
  - Metadata probes run in their own process group with a minimal environment
    (no configuration secrets) and a 2 s deadline, kill the whole group, cap
    stdout at 64 KiB, and run at most 10 at once within an 8 s list budget.
    Results are cached per mtime.
- Running a task stays v1's foreground or tmux TUI action on the developer's
  terminal. The server never executes a task. The key press is the approval,
  and agents and HTTP have no access.
- Functional test via the authenticated gateway: tree, parameters and
  interpreter; a non-executable file is skipped; the probe environment does not
  receive the server's variables; create, duplicate refusal and escape
  refusals; link and delete keeping the source; history dedupe/order; folder
  delete.
