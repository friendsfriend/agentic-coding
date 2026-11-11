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

## Provider workbench: v1 change requests, issues and CI

- The v1 GitLab/GitHub mapping layer was copied and adapted (not imported)
  into `src/providers/workbench/`, from v1 `src/server/integrations`:
  `gitlab-*`, `github-*`, `changerequest`, `issues`, `provider-time` and
  `search-result`. The TUI therefore gets v1's exact DTOs: pagination, merge
  status, approvals, pipelines, diff lines with line codes, discussions, test
  summaries and linked issues/CRs.
- `ProviderWorkbench` (`index.ts`) maps each application to the configured
  provider serving its `origin` remote. This replaces v1's per-app `provider`
  field. GitHub `api.github.com` serves `github.com`; a GitLab host also serves
  `ssh.<host>`. The remote is read from the active worktree.
  `identity` reports `{provider, sourceType}` per app, so the table shows v1's
  provider glyphs.
- Gateway method `providers.workbench`:
  - Reads: changes/change/files/versions/discussions/linked issues, issues and
    issue detail/comments/linked CRs/references, labels, collaborators, jobs,
    tests and job logs (tail-bounded).
  - Writes: comment (with diff position), approve/unapprove/toggle, rebase,
    reply/resolve discussion, close/reopen issue, labels, assign/unassign,
    issue comment, retry/cancel job.
  - These are the developer's direct TUI actions: the v1 confirm dialog or key
    press is the approval. Agents and HTTP keep the exact-digest
    `providers.preview/apply` path.
- Fences:
  - Tokens are resolved from `tokenRef` per call.
  - Every request must stay on the provider's configured origin (HTTPS except
    loopback).
  - Redirects are never followed with credentials. GitHub's signed log URL is
    fetched without them, HTTPS only and bounded.
  - Responses are bounded (4 MB upstream, 900 KB serialized, under the 1 MB
    frame budget).
  - Every string is token-masked.
  - Provider diagnostics reach the TUI as masked `Refusal` text, as in v1.
  - A missing token answers v1's `no token configured for provider "<name>"`.
- v1 behaviors kept:
  - "current" change requests need a feature branch, otherwise the list is
    empty.
  - GitLab "current" targets `develop`.
  - Lists skip per-item detail reads when paging.
  - `default_branch` falls back to the main checkout's branch.
  - Rebase and resolve are GitLab-only.
  - The CR detail fetch is GitHub-only.
- `streamJobLogs` (v1 had no server route) polls the bounded trace every 2 s
  and emits only new lines. The log modal's 1 s poll stays as in v1.
- Functional gateway test (`test/provider-workbench.test.ts`) with a loopback
  GitLab stub. It covers identity, the feature-branch rule, list mapping, issue
  label/close/comment writes, approve, jobs, token-masked job logs, retry,
  provider diagnostic pass-through, the exact outbound write sequence, and the
  missing-token refusal.
- Not yet mapped: provider CRUD (`createProvider`/`updateProvider`/
  `deleteProvider`/`getProvider`) and `searchRepos`/`getRepoBranches` for
  "add repository". These belong to the settings/provider-config step.

## Providers view and add-repository flow

- The v1 Providers view (list, add, edit, delete) and the add-repository modal
  (provider → search → branch) now run through `providers.workbench` registry
  operations: `providers`, `provider`, `create-provider`, `update-provider`,
  `delete-provider`, `search-repos` and `repo-branches`.
- Rows use the v1 shape `{name, type, username, has_token, missing_vars?}` and
  never carry a token.
- Tokens stay reference-only in `config.json`:
  - A token typed in the v1 connect modal is stored the v1 way, in the
    owner-only `CONFIG_DIR/.env` (mode 0600, atomic rename) under v1's
    generated `DEVENV_PROVIDER_<NAME>_TOKEN`. `config.json` gets only that
    `tokenRef`.
  - A `${VAR}` entry is taken as a reference and nothing is written.
  - Delete removes only the generated variable.
  - Provider references resolve from the process environment first, then from
    `CONFIG_DIR/.env` (bounded, regular file).
  - A `.env` that is not a bounded regular file, or that has multi-line
    entries, is refused rather than reflowed.
- `config.json` edits go through `Settings.updateProviders`: bound to the
  revision read, whole document re-validated, atomic, with the edit lock. The
  running host's provider list is updated in place, so the views and workbench
  see the change at once, as in v1.
- v1 GitLab providers had no URL (search took the host from the apps). v2
  derives a new GitLab provider's base URL from the most common GitLab
  origin among configured projects (`ssh.` stripped, port kept for http
  remotes), falling back to gitlab.com.
- Branch listing: v1 ran `git ls-remote --heads` with a Basic credential in a
  `-c http.extraheader` argument. v2 lists branches through the serving
  provider's API (paged, at most 1000), so no credential reaches a process
  argument.
- Test: "restored v1 Providers view and add-repository flow…" in
  `test/provider-workbench.test.ts` covers:
  - create with the token kept out of `config.json`;
  - `.env` mode 0600 and the reference shape;
  - the app's provider identity;
  - search and branch listing with the `.env`-resolved token;
  - the duplicate refusal and the username update;
  - a `${VAR}` reference reported as missing;
  - delete removing the generated secret;
  - the no-provider refusal.

## Add repository and remove repository

- The v1 add-repository submit (`createApp`) and the "Remove Selected Item"
  confirm (`deleteApp`) run through the gateway method `environment.apps`
  (`create`, `delete`, `pending`) on `AppRegistry`
  (`src/environment/app-registry.ts`). The modal submit and the confirm dialog
  are the developer's approval (decision 1a).
- Create (v1 behavior: `$DEVENV_HOME/<ident>/<ident>`, ident = v1 slugify,
  clone at the chosen branch, row shown at once with "Checking out..."):
  - The URL must be an HTTPS clone URL on the selected provider's host
    (loopback http only for tests), with no credentials, query or fragment.
  - An existing `$DEVENV_HOME/<ident>` is never adopted.
  - The checkout is authorized in `config.json` (`Settings.updateRepositories`,
    revision-bound) and registered as a definition-less project in
    `environments.json`. That write uses the definition-promotion lock, is
    validated by `validateProjects`, is atomic, and is verified afterwards.
    The live catalog, the authorized repository list and v1's implicit
    `devenv` cluster scope update in place.
  - Run, build and test targets come later through the normal definition
    review. The repository has none until then.
  - The clone runs asynchronously. v1 put the credential in a Basic
    `http.extraheader` argument. v2 passes it to a one-shot `credential.helper`
    through the child environment only, so the token never appears in an
    argument or in `.git/config`. The environment is minimal and hooks are
    disabled.
  - `pending` reports cloning or failed checkouts. The TUI shows them as v1's
    checkout operation status and clears it with `operation.status.cleared`
    when the clone finishes.
- Remove (v1 deleted the definition and `$DEVENV_HOME/<ident>`). v2 is
  stricter and refuses, never forces, when:
  - the repository is not exactly `$DEVENV_HOME/<ident>/<ident>`;
  - another project or an explicit cluster definition references it;
  - a native environment run uses it;
  - a non-terminal task or workflow uses it;
  - any worktree has uncommitted changes, or a linked worktree lives outside
    the container;
  - local commits are not pushed;
  - it is still cloning.
  Otherwise the project is dropped from `environments.json`, the repository is
  deauthorized, and the container directory is deleted.
- Functional test: "restored v1 add-repository clones under DEVENV_HOME…" in
  `test/provider-workbench.test.ts`. It uses a loopback smart-HTTP Git host
  (`git http-backend` behind a Basic challenge) and covers:
  - the clone authenticating with `oauth2:<token>` from the reference;
  - no token in `.git/config`;
  - the `config.json` and `environments.json` registration;
  - the row appearing with its provider and branch and the checkout status
    cleared;
  - the duplicate-ident refusal;
  - the uncommitted-changes refusal;
  - removal deleting the container and both registrations.

## Log AI panel, create-target script and the example config

- **Log AI panel.** In v1, `analyzeLogsWithAI` and `analyzeLogsWithAIStream`
  ran `pi --print --no-session --no-tools` and sent the output over SSE. In v2
  they go through the gateway method `environment.logs.analyze`
  (`start`/`read`/`cancel`) on `LogAnalysis`
  (`src/environment/log-analysis.ts`).
  - Each request streams one tool-less completion from the configured
    orchestrator profile's model, with the profile's thinking level.
  - The developer submitting the prompt is the approval. There are no tools,
    no transcript and no durable state, and the answer is kept in memory only
    until it has been read.
  - v1's bounds are kept: the newest 100 KB of the log with v1's truncation
    note, a 90 s timeout ("AI analysis timed out") and v1's default prompt.
    At most 2 analyses run at once and 8 are kept.
  - A gateway call is limited to 15 s, so the TUI starts the analysis and
    polls its text. The TUI's own streaming, follow-up and history flow is
    unchanged. Abandoning the stream cancels the completion.
  - The faux-provider functional test is in `operator-environment.test.ts`.
- **"No Target Configured → Create target script"** (`createShellActionScript`)
  uses `environment.apps` `shell-target`.
  - It writes v1's template to v1's path,
    `CONFIG_DIR/apps/{run,build}/<ident>-<profile|action>.sh`. An existing
    file is never replaced.
  - It registers a native `shell` target (`build-shell`, `test-shell`,
    `run-shell-<profile>`) that runs the script with `/bin/sh` in the checkout.
    The registration is validated and written atomically under the definition
    lock.
  - Duplicate targets and PowerShell are refused.
  - The add-repository test covers creating the target, editing the script,
    then building the app and reading its output.
- **First Steps → "Create example config"** is refused with guidance: add a
  provider and a repository, then create a target script. v1's generator
  writes a v1-format tree (`apps/*.json`, compose files, `devenv:` script
  headers, a `scripts/` directory under the home directory) that v2 does not
  read, and it would clone third-party demo repositories. Porting it needs a
  developer decision on v2-native demo content.

## Environment keybindings, footer and help

- **Fixed:** every environment keymap layer was dead in the shell. The runtime
  writes the embedded dialog state to `modal.active.environments` (as v1's
  dashboard host did), but the `envModal` layer field and the modal report read
  `modal.active`, which nobody sets in v2. Every layer requires
  `envModal: "none"` or a specific dialog, so no environment key matched.
  `setupDevenvKeymap(keymap, embedded)` now points the field at the namespaced
  key, as v1's `dash/keymap-setup.ts` did, and `onModalChange` reads the same
  key.
- The shell wires v1's `onKeybindCatalog` and `onModalChange`:
  - The footer on the environments page shows the environment's live command
    catalog (v1 display labels) instead of the generic menu keys and prompt
    bindings. The environments page has no prompt, as in v1.
  - While an environment dialog is open, the shell footer gives way to the
    dialog's own footer.
  - The `F1`/`?` help overlay leads with the environment's catalog.
  - `?` on the environments page opens the shared help (host-owned, as in v1),
    except while the environment takes text input (`textEntry.active`).
- The 17 v1 guides had been left in an orphaned `src/tui/devenv/app/guides`
  directory, so every Help-modal guide and the First Steps "config repository"
  guide failed to import. They now sit next to `guides/index.ts`.

## Progress: Settings direct save and Appearance

- Settings Save/Discard now act directly; neither prefills a command nor asks
  for a typed digest. `settings.save` is the authenticated operator boundary;
  it validates the complete document, requires the observed disk revision and
  uses the existing atomic 0600 writer. It preserves opaque disk keys and does
  not alter running profiles or repository/provider authority. Preview/apply
  retains its exact digest approval and stale-revision fence for other callers.
- The Settings page no longer renders a conversation prompt or advertises its
  prompt bindings. A save is never replayed after an uncertain result; drafts
  survive errors and a server re-read follows each attempted save.
- Appearance opens the copied v1 `SettingsSectionView` Theme row and the shared
  v1 `ThemePickerModal`. T opens it from Settings; `/` filters, j/k and arrows
  preview, Enter saves to v2's local `tui.json`, Escape restores the original
  theme. The modal owns its keys and preserves the existing settings draft.
  Theme initialization now happens at TUI startup, not only after entering
  Environments. No real configuration file was written during implementation.
- Verification: unfiltered type-check and lint clean (including infos); 10/10
  settings/client-gateway functional tests passed; the TUI bundles. No renderer,
  mount, navigation or snapshot tests were introduced. Visual parity remains
  developer-verified. Step 5 and runnable parity are not complete.

## Progress: native model-profile list and form

- Settings → Model profiles now uses the v1 Agent Presets profile list/form
  interaction, copied and adapted into `AgentProfilesView`: sorted Card rows,
  `+`/`=` to add, Enter to edit, `d` with the original confirmation modal to
  delete; h/l focus panes, j/k move fields/choices, Space selects, e edits text,
  Tab moves fields, Enter validates and saves, Escape finishes editing/cancels.
  Rendering uses the copied shared v1 Form/ScrollableList/Card primitives.
  The shell footer and help consume the active profile-view catalog instead of
  advertising JSON-editor or command-prefill controls. `?` opens shell help on
  Settings outside text entry.
- `settings.models` reads authenticated configured pi-ai model availability
  without refreshing providers, invoking a completion or spawning a CLI. The
  form offers that list and retains an existing model not in the list; it falls
  back to free text when the list is unavailable. Model ids are bounded strings;
  no credential or auth payload crosses the gateway.
- `settings.profile` creates/edits/renames/deletes only one native profile using
  the editor's observed disk revision. Duplicate names, missing originals and
  deleting/renaming the Orchestrator-referenced profile are refused. All native
  validation and atomic private-file fences remain; running profiles/sessions
  stay pinned. There are deliberately no legacy presets, classifiers, runtime
  selectors or delegation. Settings' obsolete whole-draft profile form was
  removed rather than kept as a second editor.
- A Settings refresh now preserves a dirty draft's original revision instead of
  silently rebasing it after a scoped profile edit or external disk change.
  Discard explicitly re-reads the server; failed/uncertain profile saves retain
  the draft and never replay. Leaving/reopening the profile form captures a new
  revision explicitly.
- Verification: unfiltered type-check and lint clean, 11/11 settings/client
  gateway functional tests passed, and the TUI bundles. The added test covers
  catalog reads, create/edit/rename/delete, stale editors, duplicate names,
  native thinking validation, referenced-profile protection, private file mode
  and unchanged running authority. No renderer/mount/snapshot/navigation tests
  or real provider/cluster/engine runs. Visual parity is still manual; Step 5
  and full runnable parity remain open.

## Progress: v1 Wiki list, note reader and review comments

- The Wiki page is the copied v1 `WikiView` interaction
  (`src/tui/otel/views/WikiView.tsx`) adapted to the native wiki in
  `src/tui/features/wiki/WikiView.tsx` plus the copied deterministic tree
  (`tree.ts`, from v1 `buildWikiTree`/`flattenWikiTree`, index/log reserved):
  a tree list with `j/k`, Enter to open or expand a directory, `w` for a new
  page, `r` to reload; an open note renders its markdown through the shared
  viewer with title/id/revision/digest, its review comments, and `e`, `c`,
  `n`/`N`, `r`, Esc exactly as v1 assigned them. The shell footer and `?` help
  read the wiki's live catalog; the Wiki page has no conversation prompt (v1
  had none) so its keys are never eaten.
- Editing is form/list based with v1's keys: h/l focus panes, j/k move
  fields/choices, Space selects, Tab moves fields, Enter validates and saves,
  Esc leaves the field or cancels; a text field opens a bounded textarea
  (Enter inserts a line, Ctrl+S saves, Esc leaves the text). Page identity,
  title and content are validated before the call.
- `wiki.save` is the authenticated operator boundary: the developer's Save
  activation is the confirmation. It reuses the native slug/title/content/
  revision validation and the same revision-fenced pi-durable transaction as
  `wiki.apply`, so stale editors are refused instead of overwritten; agents and
  HTTP keep the exact `wiki.preview`/`wiki.apply` digest approval. A review
  comment still admits one read-only `wiki-comment` task with a fresh request
  identity and its usual human review; admission is not completion and never
  modifies the page.
- Removed the previous v2 wiki JSON drafts, `/wiki-new`, `/wiki-reset`,
  `/wiki-preview`, `/wiki-apply` and `/wiki-comment` prefill commands and the
  old `WikiPanel`, so there is one wiki surface and no duplicate draft state.
  `/wiki-page ID` still opens a note. Saved pages are re-read from the server;
  uncertain saves are never replayed.
- Verification: unfiltered type-check and lint clean; 2/2 wiki functional tests
  passed (the new one covers direct saves, candidate approval still required,
  stale revisions, traversal-shaped ids, the 32000-byte bound and updates);
  TUI bundles. No renderer/mount/snapshot/navigation tests and no real runs.
  Visual parity remains manual; Step 5 and full runnable parity stay open.
