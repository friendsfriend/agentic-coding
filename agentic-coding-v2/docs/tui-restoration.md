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

## Progress: v1 Schedules views, embedded agent terminals and Home

- Schedules are v1 `SchedulesView`/`ScheduleDetails` interaction again
  (`src/tui/features/resources/SchedulesView.tsx`): a list (`j/k`, Enter to
  open details, `n` for a new schedule, `p` pause/resume, `d` + confirm to
  delete, `f` reserved for the shell filter, Esc back), a detail pane with the
  native invocation, timing, last error and the newest occurrences, and a
  form/list editor whose keys are v1's (h/l panes, j/k fields/choices, Space
  selects, `e`/Enter entry, Tab between fields, `F2`/Ctrl+Enter saves, Esc
  leaves or cancels) with a bounded textarea for long inputs. The page
  publishes its live footer/`?` catalog and hosts no conversation prompt.
- Two native operator boundaries carry the editor: `schedule.create`
  (`{id, invocation, timing, lateGraceMs}`) and `schedule.state`
  (`{id, revision, state}`), both frame-validated and revision-fenced, on top
  of the existing `schedule.delete`. The developer's authenticated form save
  is the approval (the orchestrator's `schedule_schedule` tool keeps its human
  review), occurrences still admit ordinary native tasks with their own policy
  and reviews, and a delete removes future timing only. `ResourcePanel` and the
  generic resource-preference path no longer serve the schedules page.
- OpenCode and Pi are the v1 embedded terminals again
  (`src/tui/features/agents/{terminal-agent-process,embedded-terminal,EmbeddedAgentView}.ts`):
  a real PTY (`Bun.Terminal` + `EmbeddedTerminalRenderable`), mounted on first
  visit and kept mounted while hidden so scrollback and a running turn survive
  navigation, with v1's theme handshake and exit/error surface. The terminal
  owns the keyboard: the `v2.shell` layer yields while it has focus and a small
  `v2.agentTerminals` layer keeps only Ctrl+Q, F1 and Ctrl+S as host escape
  hatches. Those pages host no conversation prompt.
- Home is v1's destination list again (`src/tui/features/home/HomeView.tsx`):
  cards for every shell destination (j/k, `g`, Enter opens), no title row and
  no keybind hints in the body; the shell default page is Home. The native
  standalone inventory is still read for the Pi/OpenCode model-thinking picker
  and `/standalone` commands, but it no longer has a list page of its own —
  where that list should live is an open decision.
- Fixed a typed seam the earlier commits shipped: the wiki and schedule
  textareas read `plainText` from their own ref instead of a non-existent
  event field, and the `wikiCatalog`/`schedulesCatalog`/`homeCatalog` signals
  are declared, so unfiltered `bun run type-check` and `bun run lint` are clean
  again. Functional test added: `test/schedules.test.ts` (create admits no task
  until due, invalid timing and unknown fields are refused, pause/resume/delete
  are revision-fenced). Full suite: 630 pass, 6 fail (the 5 pre-existing
  baselines plus the timing-sensitive Compose health test).
- Open: v1's Observability is a whole subsystem v2 does not have (v1 ports an
  OTLP/prometheus/statsd/datadog/zipkin receiver set, a SQLite telemetry store
  and 9 trace/metric/log/topology views, ~5-6k lines). Restoring those views
  needs a native telemetry source decision first; the current v2 page shows the
  native operation journals (http, query, waits, references) and does not
  pretend to be telemetry it never received.

## Observability port: storage, receivers and first shell integration

- Ported v1 contracts, SQLite TraceDb and JSONL parser into `src/telemetry`,
  removing v1 project discovery/runtime dependencies. The database requires an
  explicit v2 state directory, with private directory/database permissions.
- Ported OTLP HTTP, Datadog, Zipkin, Prometheus and StatsD decoding modules.
  HTTP ingest and bounded read endpoints run behind the existing authenticated,
  loopback-only host; this does not add unauthenticated listeners. The runtime
  owns the lazy telemetry service and closes it on shutdown. `telemetry.read`
  exposes reads through the native typed gateway.
- Copied all nine v1 trace/metric/log/topology views, their four stores and
  sparkline/topology components into the v2 observability feature. They import
  only local v2 shared UI/contracts. The initial feature composition connects
  category/list/detail navigation to authenticated reads; no conversation prompt
  is rendered on Observability.
- Synthetic authenticated HTTP test verifies ingest/read auth rejection, trace
  summary and span data, page bounds and actual runtime/database reopen.
  Focused gateway regressions pass; unfiltered type-check, zero-diagnostic lint
  and TUI bundle pass.
- NOT full parity yet: gRPC/protobuf packaging, configurable receiver lifecycle
  (including Prometheus scraping and StatsD UDP), retention controls/workspace
  registration, live change subscriptions, complete v1 filters/search/keymaps,
  footer integration and additional multi-signal security/boundary tests remain.
  No real apps, providers, telemetry collectors or user configuration were used.

## Observability follow-up: live state, search and guarded maintenance

- Native state subscriptions now carry an optional validated telemetry revision.
  Ingestion advances it and the observability feature refreshes on changes using
  the existing client subscription; there is no extra per-view polling timer.
- Segregated payloads by signal so navigating between traces, metrics and logs
  cannot interpret one record shape as another. Detail reads map back to their
  signal; span expansion is reactive and retained by span identity. Opening a
  log captures its identity/content so incoming records cannot silently replace
  the log being read. Workspace-tagged spans retain v1 change-id grouping.
- `/` edits a bounded query over loaded trace summaries, metrics and logs;
  Enter/Escape leaves entry, Backspace edits. Trace search is explicitly over
  the loaded page, not an invented global search. Observability publishes its
  footer and help catalog, and prompt-free pages route `?` to help outside their
  higher-priority input handlers.
- Oversized telemetry gateway reads now return a bounded refusal rather than
  disconnecting the socket. HTTP queries reject unknown/repeated parameters,
  empty identities and invalid bounds; private reads return no-store headers.
- `telemetry.manage` adds direct authenticated prune (1–3650 days) and
  scan/watch/unwatch for canonical configured repository roots only. Watch is
  idempotent and watchers are stopped on runtime shutdown; in-flight scans and
  watcher reads are joined before SQLite closes. These maintenance boundaries
  are implemented; their final v1 UI controls remain to be wired.
- Expanded the synthetic public-boundary test to cover multi-signal reads,
  change delivery, query refusals, oversized-read connection survival, foreign
  workspace refusal, watch/unwatch idempotence and retention. 12/12 focused
  tests pass including the existing owner/run-fenced environment telemetry
  regressions. Unfiltered type-check, zero-diagnostic lint and TUI bundle pass.
- Still open: gRPC/protobuf packaging, configured receiver start/stop controls,
  final retention/workspace UI, full v1 filter/sort modals and visual acceptance.
  This is progress toward parity, not a parity/archive claim.

## Observability follow-up: gRPC, operator controls and v1 trace modals

- Ported v1's in-process OTLP TraceService and bundled protobuf definition.
  The v2 listener binds only 127.0.0.1, bounds protobuf messages to 1 MB,
  authenticates bearer metadata before decoding, and supports ephemeral ports.
  It is traces-only, as v1 was; metrics/logs remain HTTP receiver signals.
  Added grpc-js/proto-loader dependencies and the bundled text asset loader.
- Authenticated `telemetry.receiver.read/start/stop` exposes observations and
  revision-fenced explicit controls. Starts create a private 0600 credential
  file in the v2 telemetry directory and return only its reference. No token
  value is sent through the gateway or displayed. Stop joins exports with a
  bounded grace period, revokes that file, and never adopts another listener.
  Runtime shutdown joins pending start/stop work before closing SQLite.
  Receivers are not automatically restarted or replayed after uncertainty.
- Observability → Controls now hosts list/form controls for gRPC port/start,
  stop, retention pruning and configured-repository scan/watch/unwatch.
  Stop/prune use the copied shared confirmation dialog. Back returns to the
  category list; mutations require fresh native state and are never retried
  implicitly. To configure a local exporter, use the displayed address and
  bearer metadata from the displayed private credential-file reference; do
  not paste token values into a conversation. A receiver restart rotates it.
- Copied v1 `TraceModals.tsx`: `F` opens status/workspace/span-type filtering,
  `O` opens multi-criterion sorting, h/l switches filter panes, j/k moves,
  Enter applies, Escape cancels, x clears; Space cycles sort direction and
  Shift+J/K reorders criteria. Loaded-page text search remains bounded and
  Escape restores its previous query. Added J/K page aliases, w workspace
  reset, g/G cursor endpoints and h/l tree collapse/expand, and corrected
  topology keyboard selection to follow the selected graph service.
- Receiver batches validate timestamps and finite metric samples before any
  write; malformed payload diagnostics no longer echo submitted content.
  Synthetic tests cover gRPC authentication, real protobuf ingestion, stale
  controls, duplicate-running refusal, credential revocation and runtime
  shutdown. A bundled receiver is also exercised over gRPC from an isolated
  output directory to prove the embedded proto works without source assets.
- Verification: four telemetry-port functional tests pass, including the
  bundled wire test; existing telemetry/gateway regressions pass. Unfiltered
  type-check, zero-diagnostic lint and TUI bundle pass. No real exporters,
  applications, credentials, clusters or user configuration were used.
- Still open: configured Prometheus scraper/StatsD UDP lifecycle (their decoders
  are ported but listeners are not enabled), additional visual/runtime parity
  acceptance and any remaining whole-application parity checklist items.

## Observability follow-up: owned StatsD and Prometheus lifecycle

- Implemented runtime-owned metric collectors and authenticated typed
  `telemetry.collector.read/start/stop` controls. Each source has its own
  transition/revision fence. Duplicate starts and stale controls are refused;
  bind failures never adopt or close an existing listener. Nothing starts on
  launch, reconnect or configuration discovery. Both feed the existing v1
  SQLite metric index and live metric views, not a separate substitute store.
- StatsD binds IPv4 loopback only. Its standard UDP protocol has no credentials
  or trusted identity; the controls explicitly disclose that before opt-in.
  Datagrams are capped at 8 KB/128 lines and 100 packets per second, with
  invalid/nonfinite samples refused before persistence. Stop closes only this
  runtime's socket. Port zero supports isolated synthetic verification.
- Prometheus takes an explicit local port and scrapes only
  `http://127.0.0.1:<port>/metrics`, immediately and every ten seconds without
  overlap. Redirects and process-level proxies are disabled; no credentials,
  hostnames or arbitrary paths are accepted. Each request has a two-second
  timeout and 256 KB response ceiling. Errors are sanitized and observable.
  Stop aborts and joins an in-flight scrape before SQLite closes.
- Observability → Controls now offers start/stop forms for both sources,
  separate state/address/error observations and explicit r refresh. Stops use
  the shared confirmation modal. These controls do not start an application,
  acquire a native app slot, broaden owner authority or change configuration.
- Verification uses real UDP/HTTP sockets against isolated synthetic fixtures
  through the authenticated native gateway. It covers ingestion, stale and
  duplicate controls, occupied-port no-adoption, oversized/invalid datagrams,
  redirect refusal, oversized scrape refusal, pending-scrape shutdown and
  release of the owned UDP port. The existing native app telemetry owner/run
  tests are unchanged. Fifteen focused telemetry/gateway tests pass;
  unfiltered type-check, zero-diagnostic lint and TUI bundle pass.
- This closes the missing explicitly controlled loopback collector lifecycle,
  not overall parity acceptance. Remote/config-discovered scrape targets are
  intentionally not enabled implicitly. Whole-application visual/runtime
  acceptance and any remaining original parity checklist items stay open.

## Observability follow-up: confined workspace ingestion

- Audited the copied v1 scan/watch reader against the configured-root fence.
  Repository approval alone did not prevent a linked `.herdr-workflow` folder
  or telemetry file from resolving elsewhere. Scan/watch now skip linked
  descendants, multiply-linked files and non-regular sources. The canonical
  root and each descendant are checked; reads use a no-follow/nonblocking
  descriptor and check its file identity/type before reading, rather than
  reopening a checked name through `Bun.file` after an async yield.
- Both full scans and incremental watcher tails use that source fence. A
  skipped source does not delete already retained telemetry, and background
  scan diagnostics no longer print filesystem errors containing source paths.
  Ordinary authorized appends still use their watermark without duplication.
- Workspace parsing now rejects nonfinite durations and timestamps outside
  SQLite's nonnegative signed-64-bit nanosecond range before BigInt conversion
  or persistence. One malformed record cannot prevent later valid records from
  being parsed. Parser version 5 invalidates old workspace watermarks through
  the existing derived-index re-ingest path; no manual database surgery.
- Added one authenticated public-boundary synthetic scenario covering linked
  workflow roots, directories and files, hard links, normal scan/append,
  duplicate watcher registration, a source replaced with a link while watched,
  and malformed records mixed with good records. Foreign fixture files remain
  unchanged. The six telemetry-port tests pass, as do unfiltered type-check
  and zero-diagnostic lint. No real repositories/configuration were changed.
- Overall visual/runtime parity remains open; this closes an ingestion fence,
  not the developer's manual acceptance or an archive gate.

## Observability follow-up: correlated log → trace navigation

- Wired the existing log-detail trace callback to the visible trace link and
  added t/help access while viewing a correlated log. Navigation resolves the
  wire trace/span IDs through the authenticated native gateway before opening
  a workspace tree; wire trace IDs are not treated as workspace names.
- Added `telemetry.trace.resolve`, a read-only, strict bounded identity lookup
  backed by an additive SQLite expression index. It returns an exact retained
  workspace reference or null; multiple candidate workspaces are refused as
  ambiguous. A supplied span ID must match exactly, with no silent fallback to
  another span or a workspace whose name happens to equal the trace ID.
- Uppercase wire IDs canonicalize to lowercase. Resolution never grants native
  task/run authority. Missing/ambiguous references notify without replacing
  the captured log. Async resolution is fenced by navigation, feature focus,
  client freshness and disposal, and is never automatically replayed.
- One synthetic authenticated-boundary scenario covers missing, exact,
  uppercase, shared-trace, colliding-workspace-name, span-specific and ambiguous
  references plus connection survival after invalid reads. Seventeen focused
  telemetry/gateway regressions pass (280 assertions); unfiltered type-check,
  zero-diagnostic lint, diff whitespace checks and the official Solid-enabled
  `bun run build` pass. No real exporters, credentials or apps were used.
- Visual/runtime parity acceptance remains with the developer; parity is not
  archived by these implementation or synthetic verification results.

## Observability follow-up: coherent live metric history

- Native/HTTP metric reads now project retained batches into compatible stream
  histories instead of rendering a duplicate row for each scrape/datagram.
  Stream identity includes service, name, type, unit, instrumentation scope
  and canonical resource attributes. Different resources/scopes/types/units
  never merge merely because their names happen to match.
- Point coordinates include start/end timestamps and canonical point labels.
  Newest-ingested corrections/retransmissions replace the same coordinates in
  the read projection; independently labelled points survive. Samples are
  ordered by nanosecond time, not ingest order. Raw stored batches remain
  append-only and use the existing 5000-record read window/retention policy;
  values are not silently converted into rates or delta/cumulative totals.
- Metric list row keys and both pointer/keyboard detail navigation carry the
  complete stream identity. Detail lookup refuses a name/service ambiguity
  rather than switching to another unit, scope or resource. Histogram details
  use the latest retained sample's buckets instead of the oldest sample.
- Metrics/logs now pass their existing query/edit state into the copied shared
  SearchHeader, making loaded-record search visible instead of silently
  filtering behind a count-only header. No prompt or new renderer was added.
- Metric ingest validates resource/scope/attribute shapes before persistence
  so incompatible input cannot poison the stream identity projection.
- One synthetic authenticated-boundary scenario verifies chronological
  history, retransmitted/corrected coordinates, canonical attribute ordering,
  distinct labels/resources/scopes/units/types/services, matching HTTP/native
  reads and persistence across reopen. Eighteen focused telemetry/gateway
  tests pass (296 assertions), plus unfiltered type-check, zero-diagnostic
  lint, official Solid-enabled build and diff whitespace checks. No real
  applications, credentials, providers or user configuration were used.
- Overall visual/runtime parity remains open and unarchived.

## Observability follow-up: complete bounded filter choices

- Added authenticated read-only `telemetry.filters.read`, backed by one SQLite
  read transaction over retained traces. Its workspace counts and distinct
  span names include HTTP/gRPC-ingested data, not only workspace-file metadata
  or the currently loaded 50-row page. Names containing commas/newlines remain
  exact array values rather than delimiter-split strings.
- The catalog refuses more than 1000 workspace or span-type options and refuses
  an over-budget serialized response. It never silently claims a truncated
  option set is complete. These refusals leave the gateway usable and do not
  change telemetry or native task/run authority.
- The v1 filter modal now waits for that catalog before accepting edits or
  apply. The shared criterion heading visibly reports loading; Escape still
  cancels. Once loaded, choices stay frozen for that dialog so incoming traces
  cannot shift draft indices. Reopened/navigated-away dialogs reject stale
  responses. A previously applied choice that was pruned stays explicit with
  zero retained spans rather than silently becoming the all-workspaces choice.
- Catalog failure closes the pending dialog with a notification, without
  applying a partial draft. Existing v1 status/span filtering remains over the
  loaded trace page; this is complete bounded option discovery, not a claim
  that a new global status/span query engine was added.
- One synthetic authenticated-boundary scenario covers 65 receiver-only
  workspaces beyond a 50-row page, exact counts, special-character span names,
  empty file inventory, immutable returned observations, both 1000-option
  limits, recovery after retention pruning and connection survival. Nineteen
  focused telemetry/gateway tests pass (315 assertions), plus unfiltered
  type-check, zero-diagnostic lint, official Solid-enabled build and diff
  whitespace checks. No real apps or user configuration were used.
- Overall visual/runtime parity remains open and unarchived.

## Observability follow-up: trace-scoped native topology

- Audited the copied topology model: its parent lookup used span ID alone,
  although a span ID is unique only within its wire trace. Two unrelated
  traces reusing an ID could create false cross-service dependencies.
- Added a shared, native-owned service-graph projection and authenticated
  `telemetry.read {signal:"topology"}` / HTTP topology read. Parent correlation
  now requires the same trace ID, missing parents stay unlinked, and actual
  cross-service calls contribute to edge counts instead of a fixed count of
  one. Same-service spans contribute statistics without a self-edge.
- Repeated/corrected observations of the same wire trace/span identity count
  once; latest ingestion wins, including changed event timestamps. The graph
  explicitly uses the latest 3000 ingested observations, a bounded window, not
  an unbounded whole-history query. Raw span reads remain available unchanged.
- The original TUI topology layout/interaction store now consumes that same
  projection for its graph/list/service details. Pure service cycles remain
  visible. No new renderer, environment run or task/lease authority was added.
- One synthetic authenticated-boundary scenario covers reused span IDs across
  traces, repeated calls, corrected status/duration and event time, missing
  parents, cycles, matching HTTP/native graph output, invalid queries and
  connection survival. Twenty focused telemetry/gateway tests pass (325
  assertions), plus unfiltered type-check, zero-diagnostic lint, official
  Solid-enabled build and diff whitespace checks. No real apps or user
  configuration were used.
- Whole-application visual/runtime parity remains open and unarchived.

## Observability follow-up: native, cycle-safe trace trees

- Moved the copied v1 workflow/phase/category/role grouping into a pure native
  telemetry projection. The TUI now reads `telemetry.read {signal:"tree",
  changeId}` (and matching authenticated HTTP tree output) rather than deriving
  an unrestricted recursive parent graph from raw spans in the shell.
  Local/demo TraceStore compatibility uses the same grouping implementation.
- Parent and role-claim identities now include wire trace ID as well as span
  ID. Latest observations of an exact identity win before grouping, so a
  correction cannot occupy two roles/phases or duplicate a logical span.
  Group-node identities include their first member's complete wire identity.
- Forest construction is iterative. Cycles/self-parenting promote one marked
  root without changing the stored parentSpanId. Chains beyond 64 levels per
  segment are promoted into marked segments instead of being dropped. All
  retained logical spans remain inspectable; normal v1 grouping and expansion
  defaults stay intact. The tree row/detail visibly explain cycle/depth edge
  breaks, and pointer selection matches full trace/span identity.
- Tree reads require an explicit workspace identity and retain existing read
  and frame budgets. The TUI binds payloads to that identity so a pending read
  cannot briefly show another selected workspace's old tree. No task/lease
  authority, source mutation or manual database operation is involved.
- One authenticated synthetic scenario covers colliding IDs, duplicate
  corrections, cycles/self-parenting, missing parents, a 200-span chain,
  role-claim collisions, all 209 logical spans retained from 210 stored
  observations, unchanged original parents, phase/category/role grouping,
  matching HTTP/native output and invalid-query connection survival.
  Twenty-one focused telemetry/gateway tests pass (546 assertions), plus
  unfiltered type-check, zero-diagnostic lint, official Solid-enabled build
  and diff whitespace checks. No real apps/configuration were used.
- Overall visual/runtime parity remains open and unarchived.

## Observability follow-up: standard OTLP wire compatibility and failure details

- Found and corrected a substantive limitation in the earlier gRPC proof: the
  copied v1 `.proto` used nonstandard Span/Status field numbers, and tests that
  serialized with that same file proved self-consistency, not standard OTLP
  exporter compatibility. It also omitted events. Earlier statements about
  real protobuf round trips must be read with that limitation.
- Checked the published OpenTelemetry v1.9.0 trace schema directly:
  https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/opentelemetry/proto/trace/v1/trace.proto
  The bundled wire-compatible subset now uses parent_span_id=4, name=5,
  kind=6, start/end timestamps=7/8, attributes=9, events=11, status=15,
  flags=16 and Status.code=3/message=2, with the corresponding Event fields.
  It remains TraceService-only; this is not a claim of full links/structured
  AnyValue fidelity or gRPC metric/log service support.
- Added a fixed independently encoded standard-wire fixture and sends its raw
  bytes through grpc.Client.makeUnaryRequest, without loading our .proto to
  encode. The authenticated boundary verifies exact IDs/parent, scalar types,
  scope, status, multiline exception messages/stack traces and native tree
  retention. The ordinary bundled-receiver test also still passes. No legacy
  nonstandard-wire fallback or implicit listener restart was added.
- Fixed HTTP/shared decoding to carry the enclosing instrumentation scope into
  each span. Span metadata/event shapes, scalar attributes, status/kind codes
  and timestamps are validated before writes; a malformed later record refuses
  the batch without partially inserting its valid prefix or echoing payloads.
- Span detail now exposes status messages, exception/event timestamps and
  wrapped attributes/stack traces, trace/span/parent identity, resource fields
  and instrumentation scope using the existing shared detail sections. Captured
  tool/message content keeps its existing wrapped/pretty-JSON presentation.
- Extended HTTP persistence verification to cover failure events/scope after
  reopen and atomic malformed metadata refusal. Twenty-two focused native
  telemetry/gateway tests pass (554 assertions), plus unfiltered type-check,
  zero-diagnostic lint, official Solid-enabled build and diff whitespace
  checks. The public schema browser session was closed. No real exporters,
  apps, credentials or user configuration were used or restarted.
- Existing running processes require their normal operator-controlled restart
  to load the corrected bundled schema; no real process was restarted here.
  Previously omitted fields cannot be reconstructed from old stored data.
  Overall visual/runtime parity remains open and unarchived.

## Observability follow-up: Datadog/Zipkin trace normalization

- Corrected the copied Datadog JSON adapter's units: trace `start` and `duration`
  are already nanoseconds, not microseconds. End times are added with BigInt,
  without a floating-point addition or an extra factor of 1,000.
- Datadog trace/log HTTP JSON parsing preserves unsafe-sized integer literals
  from Bun's JSON reviver source context before number rounding. Decimal uint64
  identities become canonical hexadecimal span/trace IDs; `_dd.p.tid` supplies
  the optional 128-bit trace high word. Decimal strings are also exact. Unsafe
  already-rounded numbers supplied programmatically are refused, not guessed;
  the parser does not silently fall back to rounded identities without source
  context. These remain JSON adapters, not full Datadog Agent/MessagePack support.
- Nested/flat Datadog log correlation fields now match native retained trace
  identities. Zero/absent correlation remains an unlinked log, not a rejected
  record. Millisecond log timestamps use integer multiplication, including epoch
  zero; the ordinary `error`/`fatal` severities are recognized.
- Actual Datadog `error.msg`, `error.type` and `error.stack` metadata is retained,
  with `error.msg` used for status text. Failure message/stack attribute keys
  render wrapped in the existing span detail. No exception timestamp/event is
  fabricated from Datadog metadata that supplies no such timestamp.
- Zipkin 64-bit trace IDs are zero-extended to the native 128-bit form; hexadecimal
  IDs are validated/canonicalized without changing parent identity. Microsecond
  timestamp/duration arithmetic is integral, explicit span kinds are preserved,
  and supplied annotations become events with their real timestamps.
- Added one synthetic authenticated HTTP/native-boundary scenario covering raw
  uint64 JSON integer tokens (including their low bits), 128-bit/decimal log
  correlation, unlinked logs, exact timing, native tree parentage, Zipkin kinds
  and annotations, cross-service topology and atomic malformed-batch refusal.
  Non-array Datadog batch members are refused rather than silently skipped.
- Verification: 23 focused telemetry/gateway tests pass (583 assertions), plus
  unfiltered type-check, zero-diagnostic lint, official Solid-enabled build and
  diff whitespace checks. No real exporters, applications, credentials or
  configuration were touched. No old indexed records were rewritten. Full
  visual/runtime parity remains open and unarchived; this was not a whole-suite
  run or real Datadog Agent acceptance.

## Observability follow-up: Datadog metric API versions and provenance

- Replaced the shared v1-only tuple decoder with explicit v1 tuple-point and v2
  object-point decoding selected by the authenticated endpoint. Checked the
  public Datadog Go client's v2 MetricIntakeType (0 unspecified, 1 count, 2 rate,
  3 gauge), MetricPoint (int64-second timestamp/double value) and MetricSeries
  fields rather than guessing the numeric enum or treating v2 as an alias:
  https://github.com/DataDog/datadog-api-client-go/blob/master/api/datadogV2/model_metric_intake_type.go
  https://github.com/DataDog/datadog-api-client-go/blob/master/api/datadogV2/model_metric_point.go
  https://github.com/DataDog/datadog-api-client-go/blob/master/api/datadogV2/model_metric_series.go
- V1 fractional second tokens retain their decimal source through Bun's JSON
  reviver before number rounding. Decimal/exponent seconds are converted with
  integer arithmetic; sub-nanosecond precision and values outside the native
  timestamp range refuse rather than truncate. V2 timestamps must represent
  whole seconds. Unsupported runtimes without source context refuse unsafe or
  fractional numeric timestamp input instead of silently rounding it.
- Tags split on the first colon, retaining subsequent colons, empty values and
  standalone tags. Unit, host/resource identities, source type, declared metric
  kind and interval survive normalization. A unique service tag supplies the
  display service, otherwise a unique host or the explicit datadog fallback is
  used; conflicting service tags refuse rather than guess.
- Count samples are sums; rate observations remain gauges, not fabricated
  cumulative counters. The declared Datadog kind and interval are retained in
  resource identity, so rates cannot collapse into ordinary gauges or differently
  sampled sources. Equivalent v1/v2 sources still share coherent history and
  canonical point labels permit retransmission corrections across both APIs.
  Unspecified v2 observations retain that declared kind explicitly.
- Metric detail now exposes description, resource and instrumentation scope in
  existing shared scrollable sections alongside the unchanged charts/sample
  table. This makes source/type/interval provenance inspectable rather than
  hiding it behind otherwise similar stream rows.
- Added one synthetic authenticated HTTP/native-boundary scenario proving
  nanosecond-precise v1 timestamps, v2 object points, all v2 type codes, labelled
  corrections, rate/gauge/count and host isolation, units, resource identity,
  native/HTTP projection parity, and atomic malformed-batch refusal. Wrong API
  point shapes, nonfinite/mistyped data, unsupported type codes and timestamps
  that cannot be represented faithfully are refused without partial writes.
- Verification: 24 focused telemetry/gateway tests pass (610 assertions), plus
  unfiltered type-check, zero-diagnostic lint (806 files), official Solid-enabled
  build and diff whitespace checks. The public reference browser was closed.
  No real metrics were submitted, no real app/configuration was changed, and
  previously indexed records were not rewritten or retroactively corrected.
  This is not whole-suite, cloud-intake or visual acceptance. Full restoration
  parity remains open and unarchived.

## Observability follow-up: owned StatsD observation semantics

- Replaced prefix-only StatsD parsing with full-line validation. Numeric c/g/ms/h/d
  observations, one valid sample rate and one tag list are supported; unknown or
  duplicate extensions, invalid rates and malformed values refuse a supported-size
  datagram as a whole. A valid prefix is never committed when a later line fails.
  Empty datagrams neither create observations nor clear a preceding refusal.
- Counter deltas are sums and use inverse-sample-rate adjustment, with the rate
  retained explicitly as provenance. Absolute unsampled gauges remain gauges.
  Timer/histogram/distribution values remain unaggregated gauge observations,
  with original kind and sampling rate retained, and timers carry ms units.
  No fake histogram buckets, population counts or percentile aggregates are
  invented. The detail description/resource sections expose these semantics.
- Tags preserve the entire value after the first colon, empty values, standalone
  tags and literal __proto__ keys without prototype-backed dictionaries. Series
  grouping uses structured identities including kind, rate and canonical labels
  rather than delimiter-concatenated names that could collide or mix types.
- StatsD has no exporter timestamps. Each listener now owns a wall-anchored
  monotonic observation clock so repeated samples inside/across datagrams do
  not overwrite one another at the same millisecond coordinate. These are
  explicitly collector-observed timestamps, not wire timestamps or a claim of
  nanosecond wall-clock accuracy; the clock state ends with its owned listener.
- Stateful relative/sampled gauges, sets, packed values and origin extensions
  remain explicitly unsupported rather than being misrepresented as absolute
  scalar observations. The controls disclose the supported subset alongside
  the existing unauthenticated/loopback-only warning. This is not a full StatsD
  daemon or DogStatsD aggregation implementation.
- Removed unused unowned startStatsDListener/startPrometheusScraper exports and
  the unbounded generic Prometheus fetch helper. Only the explicit runtime-owned
  loopback collectors remain: existing caps, revision fences, redirect/proxy
  refusals and joined shutdown are unchanged. No new automatic listener, remote
  target discovery, source identity adoption or native task authority was added.
- Added one synthetic real-UDP/native-boundary scenario proving repeated samples,
  counter sampling, raw timer/distribution values, distinct kinds, safe complete
  labels, per-packet atomicity, sanitized observable refusals and joined stop.
  The existing dual-collector socket/redirect/size/shutdown scenario still passes.
- Verification: 25 focused telemetry/gateway tests pass (646 assertions), plus
  unfiltered type-check, zero-diagnostic lint (806 files), official Solid-enabled
  build and diff whitespace checks. No real exporters, apps, configuration or
  previous indexed observations were changed. This is not whole-suite or visual
  acceptance; full restoration parity remains open and unarchived.

## Observability follow-up: finite classic Prometheus exposition and histograms

- Replaced comma/equal splitting and prefix-only sample matching with full classic
  text parsing. Quoted labels preserve commas, equals, braces, escaped quotes,
  backslashes/newlines, empty values and __proto__ names without prototype-backed
  dictionaries. HELP escapes and empty HELP text are retained per family; duplicate
  descriptors/series/labels and malformed lines refuse instead of silently skip.
- Explicit signed-range-compatible nonnegative millisecond timestamps become exact
  integer nanoseconds. Untimed samples share one integer scrape observation time;
  unknown process/window start is represented by zero, not an invented start time.
  Metadata-only families do not create phantom empty metric rows.
- Classic histogram bucket/sum/count samples bind to their declared family and
  labelled timestamp. Complete, consistently timed groups produce native histogram
  points with value=sum, finite explicit bounds and disjoint per-bucket counts
  derived from cumulative upper-bound counts. Count precision, monotonicity,
  duplicate bounds, the implicit +Inf bucket and count agreement are checked.
  Incomplete/inconsistent groups refuse rather than fabricate an aggregate.
- Original cumulative bucket/count/sum component samples remain inspectable;
  summary quantiles remain labelled gauges with their original count/sum streams.
  Family/type/component and cumulative temporality are retained as provenance.
  No rates, process-start timestamps, units or summary percentile aggregates are
  inferred from names. Equivalent explicit-time retransmissions replace the same
  native coordinates rather than duplicating history.
- Histogram bound labels no longer round fractional boundaries to integers, and
  the implicit final bucket displays +Inf rather than a blank label. The controls
  explicitly disclose finite classic text support and the remaining format gaps.
- Non-finite samples are valid Prometheus values but are not yet representable by
  the finite-only native metric model. This slice refuses the entire affected
  scrape with an observable sanitized error; it does not silently drop NaN/Inf or
  pretend those exporters are fully supported. OpenMetrics directives/exemplars
  and native histograms likewise remain unsupported. Non-finite representation
  remains a follow-up protocol/model gap, not an archived acceptance item.
- Added one synthetic owned HTTP-scraper/native-boundary scenario proving escaped
  labels, timestamps, family metadata, raw and projected histogram counts, summary
  fields, empty HELP, retransmission correction and malformed/unsupported scrape
  atomicity. No parser/helper, renderer, mount or snapshot tests were introduced.
  Empty successful scrapes no longer bump the data revision by ingesting nothing.
- Verification: 26 focused telemetry/gateway tests pass (672 assertions), plus
  unfiltered type-check, zero-diagnostic lint (806 files), official Solid-enabled
  build and diff whitespace checks. No real exporter, app, configuration or old
  indexed observation was changed. Whole-suite, real-exporter and visual/runtime
  acceptance remain outstanding; full restoration parity is open and unarchived.

## Observability follow-up: JSON-safe non-finite measurements and native statistics

- Supersedes the preceding finite-only Prometheus scalar limitation. Canonical
  NaN/+Inf/-Inf values (and the Inf alias) are now retained, including empty
  summary quantiles and non-finite histogram sums with valid finite count/bucket
  data. Native histograms/OpenMetrics and non-finite histogram counts remain
  unsupported; other wire adapters retain their existing codec boundaries.
- The shared point contract distinguishes ordinary numeric values from explicit
  special measurements: `{value:null, nonFiniteValue:"NaN"|"+Inf"|"-Inf"}`.
  Bare nulls, invalid tokens, raw non-finite JS numbers and numeric values with
  contradictory tags are not valid normalized measurements. Nothing silently
  turns into zero or an unmarked null during JSON serialization.
- Native merged-history reads now compute read-only `statistics` after latest
  coordinate corrections. Average/min/max cover finite measurements only;
  count includes all retained observations and finiteCount reports the finite
  subset. All-special/empty streams have null statistics, not fabricated zeros.
  A convex running mean avoids overflow from summing large finite measurements,
  and the single shared implementation avoids spread/argument-count limits.
  Ingested or stale statistics are never trusted by the native read projection.
- The TUI consumes this projection, with the same helper only as its local-data
  compatibility fallback. Detail labels explicitly identify finite statistics
  and finite/total counts; special samples display their literal tokens. They
  occupy gaps in sparklines instead of becoming zeros or disappearing from
  observation coordinates. Zero histogram buckets no longer paint fake bars.
- Sample identity still consists of timestamps/labels, not mutable value state.
  Finite-to-special and special-to-finite corrections replace the same sample,
  remove stale flags and recompute statistics, without duplicating history.
- Added one synthetic owned-scraper/authenticated native/HTTP scenario proving
  JSON-safe tokens, all-special and mixed statistics, real zeros, large finite
  averages, unknown histogram sums with retained bins, empty summary quantiles,
  correction in both directions, malformed-null refusal and SQLite reopen. A
  reopened runtime remains stopped and does not adopt/restart the old collector.
  The old NaN-refusal case now checks actual numeric overflow instead; NaN
  acceptance is covered by the new functional round trip, not a helper/UI test.
- Verification: 27 focused telemetry/gateway tests pass (693 assertions), plus
  unfiltered type-check, zero-diagnostic lint (807 files), official Solid-enabled
  build and diff whitespace checks. No real exporter, application, credentials,
  configuration or old indexed observation was edited. This is not whole-suite,
  real-exporter or visual/runtime acceptance. Full restoration parity remains
  open and unarchived; remaining codec/format gaps are not waived.

## Observability follow-up: ProtoJSON OTLP metric decoding

- OTLP HTTP/JSON metric points no longer coerce absent or special measurements
  to zero. Gauge/sum points must carry exactly one of `asDouble`/`asInt`;
  neither, both, a fractional or out-of-double-range `asInt`, an overflowing or
  non-numeric double, a missing/invalid observation time, and an unsupported
  metric kind (e.g. OTLP `summary`) refuse the whole payload with the existing
  sanitized 400 and no partial ingestion.
- ProtoJSON special strings (`"NaN"`, `"Infinity"`, `"-Infinity"`) map to the
  shared explicit special measurements, and numeric strings are accepted where
  the spec allows them. Int64 values must be exactly representable by the native
  double model; a larger integer is refused rather than rounded into a
  different measurement.
- An absent `startTimeUnixNano` is now the documented unknown start `"0"`
  instead of a copy of the observation time, so a gauge no longer claims the
  measurement began when it was taken. Present start times are validated.
- Histogram points project the OTLP `sum` (optional in the protocol) rather than
  the sample `count` into the shared metric value, matching the assembled
  Prometheus histogram convention. A histogram that reports no sum keeps an
  explicit `unknown` special measurement — a new token restricted to histograms
  by record validation — instead of a fabricated zero sum. Bucket counts are
  validated as non-negative safe integers, one bucket must follow the bounds,
  bounds must be finite and strictly increasing, and a reported count must equal
  the bucket total.
- Record validation now enforces the same rules on every ingestion path, so a
  malformed normalized metric cannot reach storage through a different receiver.
- Added one synthetic authenticated OTLP JSON/native/HTTP scenario proving
  special tokens, exact maximum-safe integers, unknown starts, string doubles,
  histogram sum projection, unknown sums, finite-only statistics, and fourteen
  malformed/unsupported batches that are refused atomically with no revision
  change and no partial write.
- Remaining gap: OTLP exponential histograms, summaries, exemplars/links and
  >2^53 integer measurements are still not representable and are refused or
  absent rather than approximated. Verification: 28 focused telemetry/gateway
  tests pass (748 assertions), unfiltered type-check, zero-diagnostic lint (807
  files), official Solid-enabled build and diff whitespace checks. No real
  exporter, application, credential, configuration or old indexed record was
  touched; whole-suite, real-exporter and visual/runtime acceptance remain
  outstanding, so full restoration parity stays open and unarchived.

## Observability follow-up: truthful OTLP log records

- An absent OTLP severity is no longer reported as `INFO`. `severityText` wins
  when it has content; otherwise the OTel `severityNumber` (numeric or its
  ProtoJSON enum name) maps to that number's own name, so 10 is shown as
  `INFO2` rather than rounded to `INFO`. A number outside the OTel range is
  refused even when a text is present, because the record contradicts itself.
  This is a deliberate truthfulness divergence from v1, which displayed every
  unset severity as `INFO`: the log list renders `—` and the detail header
  `UNSPECIFIED`, while the stored record keeps the empty severity.
- The log severity filter treats an unspecified level as unknown rather than as
  the least severe one. A minimum-severity filter narrows only records whose
  source stated a level, so unknown records are never silently hidden.
- Log bodies decode the OTLP AnyValue instead of dumping the raw wrapper: string,
  bool, exact int64 (the source's own decimal, never rounded through a double),
  double (a special value keeps the token the source wrote), bytes as its base64
  payload, and bounded recursive array/kvlist structures as JSON. An unknown or
  malformed AnyValue, a non-integer `intValue`, a non-list array/list value, or
  a list entry without a key refuses the payload rather than printing noise.
- Log correlation ids are used exactly or not at all: 32/16 lowercase hex, an
  empty string and the protocol's all-zero "unset" id become absent correlation,
  and any other shape refuses the payload so a query can never match a trace the
  record never named.
- `timeUnixNano` is validated and falls back only to the record's own
  `observedTimeUnixNano`. A record with neither is refused: it would otherwise
  sort at the epoch and be pruned as ancient, which silently loses the
  observation instead of reporting that it cannot be placed in time.
- Added one synthetic authenticated OTLP JSON/native scenario covering text,
  numeric and named severities, an unset severity, text-over-number precedence,
  observed-time fallback, scalar/structured bodies, exact int64 text, special
  double text, correlation normalization and unset ids, plus ten malformed
  records refused atomically with no partial write and no revision change. The
  oversized-body case of the earlier multi-signal test now carries a timestamp.
- Remaining gaps: OTLP span/log attributes still stringify non-scalar
  `AnyValue`s, and OTLP exponential histograms/summaries/exemplars remain
  unsupported. Verification: 29 focused telemetry/gateway tests pass (792
  assertions), unfiltered type-check, zero-diagnostic lint (807 files), official
  Solid-enabled build and diff whitespace checks. No real exporter, application,
  credential, configuration or old indexed record was touched; whole-suite,
  real-exporter and visual/runtime acceptance remain outstanding, so full
  restoration parity stays open and unarchived.

## Observability follow-up: OTLP attribute values, span enums and event times

- One AnyValue decoder now serves span, resource, event, log, metric-point and
  log/metric-resource attributes instead of a second per-call-site coercion.
  Scalars stay typed; an int64 that a double cannot carry exactly is reported as
  the source's own decimal text rather than a rounded number; a special double
  keeps the token the source wrote; bytes stay base64; a bounded nested
  array/kvlist becomes JSON text instead of the previous silent empty string.
  A record with no attribute key, an empty key, a missing value, a non-integer
  `intValue`, an over-deep structure or an unknown AnyValue shape refuses the
  payload. The legacy map-shaped attribute object is still accepted and decoded
  by the same rules; any other attribute shape is refused rather than ignored.
- Span kind and status code accept both the ProtoJSON number and the enum name
  (`SPAN_KIND_SERVER`, `STATUS_CODE_ERROR`), and an out-of-range or unknown value
  is refused. Previously any non-object status other than the literal `"ERROR"`
  silently became unset, and a bogus enum name became `NaN`. A status message
  must be text. `droppedAttributesCount` is validated as an exact int64 instead
  of being coerced through `Number`.
- A span event no longer inherits the span's start time when the source reported
  no event time: `SpanEvent.timeUnixNano` is optional, validation accepts its
  absence, the detail view omits the timestamp row, and a present but invalid
  time refuses the payload. An exception event therefore can no longer claim it
  happened at the span's start.
- Added one synthetic authenticated OTLP JSON/native scenario covering typed,
  exact-int64, special-double, bytes, array and kvlist values on span, resource
  and event attributes, enum-name kind/status, exact dropped count, an event
  without a reported time, thirteen malformed shapes refused atomically with no
  partial write, and no revision change.
- Remaining gaps: OTLP exponential histograms, summaries, exemplars and links
  stay unsupported, and >2^53 integers stay textual. Verification: 30 focused
  telemetry/gateway tests pass (842 assertions), unfiltered type-check,
  zero-diagnostic lint (807 files), official Solid-enabled build and diff
  whitespace checks. No real exporter, application, credential, configuration or
  old indexed record was touched; whole-suite, real-exporter and visual/runtime
  acceptance remain outstanding, so full restoration parity stays open and
  unarchived.

## Verification baseline: whole suite green again

- Ran the complete suite unfiltered (113 files, 656 tests, 5800 assertions,
  ~504 s) and fixed the three stale expectations it exposed. No product source
  changed in this slice: the code was already right and the tests had drifted.
- `test/config.test.ts` still expected only the `code`/`research` system skills;
  the `wiki-comment` read-only system skill has been part of config loading since
  the wiki restoration, so the expectation now lists it.
- `test/cli.test.ts` spawned the disposable host with piped stdout. The CLI
  defaults to the OpenTUI client and refuses to start it without an interactive
  terminal, so the host now starts with its documented `--headless` mode, which
  is what a scripted, non-TTY boot means.
- `test/providers-extended.test.ts` stubbed three upstream writes with the wrong
  verb and lacked the authenticated-user read: GitLab issue updates and
  discussion resolution are `PUT`, GitHub review dismissal is `PUT`, and
  GitHub unapproval verifies the configured user through `GET /user`. The stub
  now answers those exact requests (an unstubbed verb stayed a visible 500
  rather than being silently accepted).
- Result: 656 pass, 0 fail, unfiltered type-check, zero-diagnostic lint (807
  files), official Solid-enabled build and diff whitespace checks. This is
  synthetic/unit/integration verification only: it does not establish visual
  TUI, real-exporter, real-provider or real-cluster acceptance, and full
  restoration parity stays open and unarchived.

## Shell parity: the v1 location picker (Ctrl+P)

- Restored the v1 destination jump list that v2 lacked entirely: `Ctrl+P` opens
  a read-only picker over the shell's pages, `j/k`/arrows/`PgUp`/`PgDn`/`g` move,
  `/` starts a query, printable keys filter, `Enter` jumps and `Esc` or `Ctrl+P`
  closes. The current destination is marked, and the list windows the selection
  instead of growing past the modal.
- One catalog now drives the Home listing, the picker and the page-name lookup
  (`src/tui/shell/locations.ts`), so the label and description of a destination
  cannot drift between surfaces — the same single-catalog rule v1 documented.
  The previous duplicate `pages`/`PAGE_DESCRIPTIONS` tables in the shell are
  gone; `Object.fromEntries` keeps their lookup shape.
- Selecting a row calls the shell's own navigation (`go(page, resource)`), so
  back/forward history, breadcrumbs, focus and the workspace layout behave
  exactly as a sidebar jump. The picker prepares no prompt text, dispatches no
  gateway method and writes no configuration; it is fenced like the other local
  dialogs through the shell's modal guard.
- `Ctrl+P` was unbound in v2 (`Ctrl+K` opens the command-suggestion palette), so
  no existing binding moved. The key is advertised in the shared Shell keybind
  catalog, which is what the footer and help overlay project.
- Remaining gap, stated rather than implied: v1 also listed *loaded in-memory
  resources* in this picker (recent traces, metric streams, topology services).
  Those live inside each feature's own store in v2, so only page destinations are
  offered here; resource-level entries need a per-feature published catalog and
  are the follow-up. Verification: unfiltered type-check, zero-diagnostic lint
  (809 files), official Solid-enabled build and diff whitespace checks pass, and
  the gateway/tui client suite stays green. The picker was not opened in a real
  terminal here — visual/runtime acceptance stays user-owned, so full
  restoration parity remains open and unarchived.

## Shell parity: the global theme picker (T)

- v1 advertised the theme picker on every page (`T`, Actions); v2 offered it only
  from the Settings page. `T` (`shift+t`) now opens the same shared picker from
  any page and applies/persists the chosen theme through the existing local
  preferences adapter — no gateway call, no configuration beyond the theme name
  v1 already wrote.
- The key defers to text entry: a focused prompt owns every printable key, so `T`
  does nothing there, and the Settings page keeps its own explicitly anchored
  picker (its higher-priority layer answers first and this binding skips that
  page) so two dialogs can never open at once. The picker is part of the shell's
  modal fence, and Escape/Enter keep the shared picker's own behaviour.
- The key is advertised through the shared Shell keybind catalog, so the footer
  and help overlay project it exactly like the location picker.
- Also recorded here: the observability `w` key now resets the selection and
  reports "All workspaces", matching v1's own notice on that key.
- Verification: unfiltered type-check, zero-diagnostic lint (809 files), official
  Solid-enabled build, diff whitespace checks and the gateway/client suite. The
  picker was not opened in a real terminal; visual/runtime acceptance remains
  user-owned and full restoration parity stays open and unarchived.

## Observability views are locations (v1 parity)

- v1 routed each observability view separately (`OBSERVABILITY_VIEWS`), so its
  picker could jump straight to metrics or topology. v2 addressed only the page,
  so every jump landed on the feature's front page. `src/tui/shell/locations.ts`
  now publishes the four views (traces, metrics, logs, topology) as their own
  grouped destinations, and the feature honours them.
- The handoff is a *location*, not a command: the shell already carries
  `View.resource`, so the picker calls `go("observability", "logs")` exactly like
  a row jump anywhere else, and `TelemetryFeature` takes an optional `resource`.
  A sentinel — not the initial value — records what it applied, so a jump that
  mounts the feature opens the named view while an unchanged value never fights
  the developer's own navigation inside the feature. An unknown value is ignored
  rather than guessed at.
- Arriving this way is identical to choosing the view by key: `navigate()` clears
  the filter, the modal, the search flag, the selection and the trace/metric/
  service identity, and then performs the same bounded read. No filter, sort or
  selection can be smuggled through a location.
- The destination picker (`Ctrl+P`) is the only way to address the same views from
  the keyboard: a view is a location, not a prompt command, so there is no
  `/view` to keep in step with the catalog, and the picker marks the view the
  shell currently holds as `· current`.
- Not claimed: v1 *also* listed loaded resources (recent traces, metric streams,
  topology services) in this picker. v2 reads one bounded page per surface and
  keeps no standing cache across surfaces, so those entries would need a
  deliberate cache in the feature; that remains open and is not implied by this
  change. Verification: unfiltered type-check, zero-diagnostic lint (809 files),
  official build, gateway + telemetry-port suites (27 tests) and diff whitespace
  checks. No real terminal run here, so visual acceptance stays user-owned and
  full restoration parity stays open and unarchived.

## The location picker uses v1's row chrome and pointer behaviour

- Rows are now the shared `Card`/`Selectable` row v1 used, not a local
  hand-rolled box: indicator strip, hover fill, selected surface and the row
  gesture all come from the one component the shell's other lists already use,
  so the picker cannot drift from them.
- Pointer behaviour matches v1 exactly: a single tap selects *and* accepts, the
  legacy picker's own contract. Hover, wheel-swallowing and backdrop-tap-to-close
  come from the frame.
- Geometry follows v1's dialog: 60% of the terminal in both directions (clamped),
  a `Locations` title row above the search row, and the window computed from the
  framed height, so the selection stays visible with no separate scroll state.
  Each row's second line is `group · description` as in v1, with the shell's
  current location marked.
- A local `window` accessor that shadowed the global name was renamed
  (`listing`); the picker keeps zero diagnostics under the repository's rules.
- Verification: unfiltered type-check, zero-diagnostic lint (809 files), official
  build, gateway suite and diff whitespace checks. Still no real terminal run
  here: visual/runtime acceptance remains user-owned and full restoration parity
  stays open and unarchived.

## Loaded traces are picker locations (v1 parity, without a cache)

- v1's picker listed the resources a surface had loaded, so a developer could
  jump back to a trace from anywhere. v2's observability feature holds one
  bounded page per surface and keeps no cross-surface cache, so the missing piece
  was the *handoff*, not the data: a feature may now publish its own locations to
  the shell, and the shell owns the copy the picker reads.
- `TelemetryFeature` publishes the traces of the page it currently shows (at most
  twelve, named by their root span, described by span count, duration, errors and
  agents) and publishes an **empty** list for every other view. A trace is
  therefore never offered from a page the developer cannot see, nothing is read
  to build the list, and no standing cache was introduced to make it work.
- Choosing one carries `trace/<traceId>` as the view's resource, the same channel
  the four view locations already use. The feature applies it by setting the
  trace and opening the tree view, which is exactly what `Enter` on that row does
  — so a stale entry can only fail where the row itself would fail, with the
  existing refusal notice rather than an invented trace.
- The picker treats published entries as one more group ("Loaded traces") and the
  current-resource marker works for them; search and the window are unchanged.
- Verification: unfiltered type-check, zero-diagnostic lint (809 files), official
  build, gateway + telemetry-port suites (27 tests) and diff whitespace checks.
  No real terminal run here: visual/runtime acceptance remains user-owned, and
  full restoration parity stays open and unarchived.

## Metric streams and services are picker locations too

- The publishing handoff added for traces now covers every observability list
  v1 offered: metric streams ("Loaded metric streams") and topology services
  ("Loaded services"), each bounded to twelve entries and published only while
  that view is the one on screen. Any other view publishes an empty list, so the
  picker never offers a resource the developer cannot already see.
- Each entry carries an **identity**, not a position: a trace id, a service id,
  or a metric stream's own `metricStreamId` (service, name, type, unit, scope and
  resource attributes). Arriving through a location therefore survives a filter,
  a sort or a reordered page, which a row index would not.
- Resources are now `trace/<id>`, `service/<id>` and
  `metric/<service>/<name>/<streamId>`, with each component percent-encoded (a
  stream id is JSON, and a service or metric name may contain a separator).
  Parsing decodes exactly the components it re-sets; an empty component is
  refused rather than guessed at.
- Applying one resets the other detail identities first (`setTrace(""),
  setMetric({…empty}), setService(undefined)`) and then opens the matching detail
  view, which is the same transition `Enter` on that row performs — so a stale
  entry fails exactly where the row would, with the existing refusal notice.
- Verification: unfiltered type-check, zero-diagnostic lint (809 files), official
  build, gateway + telemetry-port suites (27 tests) and diff whitespace checks. No
  real terminal run here: visual/runtime acceptance remains user-owned and full
  restoration parity stays open and unarchived.

## The view window (v1 Ctrl+T) without a second owner

- v2 is one process per state directory: the host and its TUI share a lock, so
  v1's "open this view in a window" had no equivalent at all. The missing piece
  was a *client* mode, not a window mode, and that is what was added.
- `agentic-coding-v2 --attach-url URL [--route JSON]` opens a client of a running
  host and never starts, owns or locks one. It refuses `--headless` and it
  refuses `--port`/`--state-dir` outright ("attaches; it never starts a host"),
  so an attached window cannot become a second authority by accident.
- The credential is read from `AGENTIC_CODING_V2_ATTACH_TOKEN` in the child's
  environment and never from a command line, so it does not appear in `ps` —
  v1 passed its token as `--attach-token` on argv, and that is the one place this
  restoration deliberately does better. A missing token is refused before any
  connection, config read or lock attempt.
- `--route` is a *location*, not a command: `{page, resource}` is validated
  (a page-shaped name and a string-or-null resource) and applied once on mount
  against the shell's own page catalog, so an unknown page is ignored rather than
  navigating somewhere else. Nothing is prefilled into the prompt, and no draft,
  approval or gateway method travels through a route.
- `Ctrl+T` in the shell calls the window opener the TUI was started with. The
  opener is tmux-only by v1's own contract: without `$TMUX` and a `tmux` binary it
  reports "tmux is not available; run the shell inside a tmux client" instead of
  falling back to a detached process, and a failed `tmux new-window` reports its
  own reason. The window name is derived from the location
  (`acv2-<page>[-view]`). A shell with no host to attach to says so instead of
  spawning anything, and a focused prompt keeps the key.
- Tests (`test/attach-window.test.ts`, synthetic, authenticated boundary only):
  a second client with the same token receives its own fresh snapshot of the same
  host — same task identities, no ownership transfer — and closing it leaves the
  first client connected and fresh; the page catalog a route is validated against
  cannot contain a page the shell does not render.
- Verified: unfiltered type-check, zero-diagnostic lint (810 files), official
  build, cli + gateway + attach suites (10 tests) and diff whitespace checks. The
  four attach refusals were exercised directly (missing token, `--headless`,
  `--port`, non-TTY) without starting a host. No real tmux window was opened here
  and no real terminal run happened: visual/runtime acceptance remains
  user-owned, and full restoration parity stays open and unarchived.

## Shell parity audit: what is closed, and what is not a gap

A pass over v1's keybind catalogs against the v2 shell, after the location
picker, the theme picker and the view window landed. This entry records the
result so the remaining work is stated rather than assumed.

- **Shell chrome: closed.** v1's host keys are `?`, `T`, `Ctrl+P`, `Ctrl+T`,
  `q`, the diagnostics key and the four panel keys (`Ctrl+S`, `Ctrl+A`, `Ctrl+H`,
  `Ctrl+L`). v2 answers all of them: `?`, `T` (theme), `Ctrl+P` (locations),
  `Ctrl+T` (view window), `Ctrl+Q` (quit), `Ctrl+Alt+N` (cached diagnostics),
  `Ctrl+S` (workspace toggle), `Ctrl+V` (agent sidebar — v1's `Ctrl+A` panel key,
  renamed because v2 keeps printable keys free), `Ctrl+H`/`Ctrl+L`
  (previous/next workspace). v1's `Back`/`Forward` and history keys are present
  too, and `Ctrl+K` keeps the command palette that `Ctrl+P` used to hold.
- **Sidebars: not a gap.** `f` (cycle active/attention/all) and `e`
  (expanding/permanent) were already bound twice over — once by
  `WorkspaceNavigation` for the task sidebar and once by
  `NativeAgentNavigation` for the agent sidebar — so a candidate change adding
  them to the shell was reverted after reading the components. Recorded here
  because the shell's own `/help` line ("f cycles in sidebar") looked like it
  advertised a key nothing bound; it does not.
- **Feature-local actions that v2 intentionally does not have** (they belong to
  v1's workflow dashboard, which v2 replaced with native tasks, reviews and
  evidence): workflow delete, workflow graph, agent cost breakdown, delegated
  debug requests, plan/report line navigation, stage flow page, job/schedule
  creation wizards, and the workflow-window key `n`. Restoring those means
  restoring the surfaces, not the keys, so they are out of scope for the shell
  and are not counted as parity regressions.
- **Verification:** the whole suite now runs unfiltered and green — 114 files,
  658 tests, 5806 assertions, 425 s — including the new attach-window boundary
  test, on top of unfiltered type-check, zero-diagnostic lint (810 files), the
  official build and diff whitespace checks. Visual/runtime acceptance remains
  user-owned; full restoration parity stays open and unarchived.

## The shell sidebar is the navigation tree, and its cursor is the caller's

Two defects the developer reported after the first real run, and the fix for both.

- **The cursor bounced back.** `WorkspaceNavigation` kept its own cursor signal
  and re-synced it from the current route on every change, so a `j` that moved
  the cursor was undone by the next snapshot or re-render. Selection is now the
  *caller's* state (`cursor`/`onCursor`), which is v1's own contract for
  destination lists ("selection state is controlled by the caller so it can live
  in route-keyed view state"). The shell owns the cursor, moves it only on a
  route change that names a row, and a row move never navigates — so nothing
  inside the panel can reset what the developer just selected.
- **The entries were padded.** The sidebar is the shell's navigation tree and
  nothing else: `Menu` (the Home destination list, previously labelled Home),
  `OpenCode`, `Pi`, `Orchestrator`, then that orchestrator's child sessions.
  Tasks, saved viewpoints and the page list are gone from it — every other
  surface is reached through Menu, exactly as v1's destination list worked, and
  the child rows no longer hide behind a disclosure row.
- **Pi Durable is not a sidebar row any more.** The page and its native authority
  stay (and `Alt+3` still reaches them); only the row is gone, pending
  the multiple-orchestrator sessions that replace it.
- The four leading rows are the panel's fixed pins; child sessions scroll, and
  `Ctrl+H`/`Ctrl+L` cycle the four routes without stepping through sessions.
- Verification: unfiltered type-check, zero-diagnostic lint (810 files), official
  build, gateway suite and diff whitespace checks. The reported interactions were
  not exercised in a real terminal by this change, so the run remains the
  developer's acceptance.

## The sidebar opens its rows, and it is the surface the shell starts in

- **Enter reached the rows.** The panel bound only `enter`, so a terminal that
  reports Return under the other name looked like a dead key. The sidebar, the
  agent sidebar and the breadcrumb catalog now bind both names — the Home list
  already did, which is why that one worked. Row marks follow the new tree
  (`⌂` Menu, OpenCode, `π` Pi, `∞` Orchestrator) instead of the retired
  `mode:<index>` keys.
- **The shell starts with the navigation tree focused.** It opened on `content`,
  so the first `j`/`k`/`Enter` went to whatever list the page happened to show —
  on the start page that is the destination list, which is why keys looked like
  they moved the wrong thing. Opening a destination hands focus to its content,
  so typing works the moment a prompt exists.
- Verified in a pseudo-terminal against an isolated config/state dir (no provider,
  no credential, no real host): start → `j` → `Enter` opens OpenCode and the
  embedded agent paints its own screen in the content area. Reproduced the
  original complaint the same way: without sidebar focus, `j` `j` `Enter` on the
  start page opened *Environments*, because those keys belonged to the
  destination list. The probe directories were removed afterwards.

## Orchestrator siblings: the backend of the `+` row (A2)

Decisions taken before any UI: an orchestrator is **one conversation**, and the
root is only the first of them.

- `harness.createConversation({ ownership: { kind: "ownerless" }, agent })`
  makes a **sibling of the root**, not a child: cancel, cascade and retirement of
  one orchestrator never reach another. A second harness was rejected — it would
  duplicate environment, git, telemetry and review authority and collide
  conversation ids across projections, tasks and evidence.
- `src/orchestrators.ts` keeps the registry. The root's entry is *synthesized*
  (`id`, title `Orchestrator`, `config.repositories[0]`, orchestrator profile), so
  older state needs no migration; created ones live in `Catalog.orchestrators`
  keyed by conversation identity. `read()` returns the root first, then creation
  order.
- A created orchestrator's agent is the **same** agent change as the root's
  (`Runtime.orchestratorAgent(cwd)`): same extensions, same tools, same
  instructions, same orchestrator profile — the directory is the only difference.
  `cwd` is the chosen path, so its shell and file tools work there and nowhere
  else by default.
- The path is taken as given: absolute, existing, a directory, symlinks resolved.
  No worktree, no branch, no clone, no discovery. A refused path creates nothing,
  which is why the catalog stays at one orchestrator after a refusal.
- `orchestrator.read` / `orchestrator.create` are the wire methods; `frames.ts`
  validates an integer identity, a bounded title, an absolute path and the
  profile, so nothing else can arrive on that response.
- Sessions: every orchestrator is a top-level session (`parent: null`,
  `task: null`) *before* its children, so `clientSession` resolves it to its own
  conversation and the shell's existing tree can show them without a second
  listing. A task records `orchestrator` at admission — the tool call's own
  conversation — and a child's `parent` is that orchestrator; tasks admitted
  before attribution existed, and scheduled or wiki-started tasks, stay with the
  root.

Verification: `test/orchestrator-sessions.test.ts` (2 tests) creates an
orchestrator through the authenticated client, reads the catalog back, reads the
transcript through `session.context`, expects it in `state.read` as a parentless
session, and expects a relative, missing and non-directory path each to be
refused with an unchanged catalog. Whole suite and the official build stay green;
the `+` row, the chooser and the sidebar tree grouping are the next slice.

## The `+` row: a new orchestrator from the navigation tree

The sidebar now *is* the tree A2 describes, and the row that grows it:

```
⌂ Menu
󱚞 OpenCode
π Pi
∞ Orchestrator          ← the reserved root, from `state.sessions`
∞ agentic-coding-v2     ← a created orchestrator (its own directory)
  ▸ task #12            ← child sessions, under the orchestrator that admitted them
+ + New orchestrator
```

- **Tree, not a list.** `sidebarOptions()` reads `state.sessions` once: every
  `parent === null` session is a root row (glyph `∞`, `Orchestrator <id>`), and
  every session whose `parent` is that root follows it (glyph `▸` writable, `·`
  otherwise, at most 20 per root). No further listing exists, so the shell cannot
  disagree with the host about who owns a child.
- **The mark is the row's.** `WorkspaceEntry.glyph` lets the caller name a row it
  can identify; the panel's own table still marks the fixed destinations.
- **The cursor still follows routes, not rows.** `workspaceSelected()` maps both
  transcript pages (`orchestrator` and `session`) to `session:<id>`, so a
  conversation selected in any way marks exactly one row.
- **`+` is an action, not a destination.** `orchestrator:new` opens the chooser
  instead of navigating, and `cycleWorkspace` skips it (and sessions) so cycling
  visits routes only.
- **The chooser** (`src/tui/ui/OrchestratorChooser.tsx`) is a `ReadOnlyModalFrame`
  like the location picker: a path line prefilled with the shell's own `cwd`,
  editable by typing (`up`/`down` pick a row, `Enter` starts, `Esc` cancels), a
  custom row that binds the typed path, and a **Configured checkouts** group —
  `state.environments.projects` filtered to `kind` `app` or `library`,
  deduplicated by directory and shown as `id` + resolved repository. Nothing is
  read from disk and nothing is created until the host accepts: the shell sends
  `orchestrator.create`, refreshes `state.read` only after it answers, then
  navigates to `session:<id>`; a refusal is reported as it came.
- **Breadcrumb**: a session without a task is an orchestrator, so it reads
  `Orchestrator › <title>` instead of the old `Pi Durable › …`, which described a
  page that no longer exists.

Verified in a real pseudo-terminal at 160 columns against a throwaway config and
state: `k` wraps to the `+` row, `Enter` opens the chooser with the typed path and
the configured checkout listed, `Enter` again creates the orchestrator and lands on
`» Orchestrator › agentic-coding-v2`; after a restart the sidebar shows both roots
(and the created one survives); `Escape` in the chooser creates nothing. The host
side of the same flow is `test/orchestrator-sessions.test.ts` (3 tests): creation,
refusal with an unchanged catalog, and a child session nested under the
orchestrator that admitted it.

## The chooser's first checkout used row 0 too

Developer screenshot: the custom path and the first configured checkout were both
marked at index 0. The custom path owns row 0; a configured row owns its position
in the *configured* slice plus 1 and the slice offset. `listing().start +
position()` was wrong at the start of the list (both row 0), and it also made the
window show one extra configured row there.

`configuredOffset()` now names the configured slice's offset; `rowIndex()` is
`1 + configuredOffset() + position`. The slice reserves one row for the custom
path when that row is visible, so the window's size is respected. Selection and
pointer activation use the same index, and Enter still acts on `rows()[index]`.

Verified in a real tmux terminal at 150×40 against throwaway config/state with 12
configured app/library checkouts and an excluded infrastructure entry: at index 0
only the custom row is marked, Down marks only checkout-00, scrolling to index 10
marks only checkout-09, and Enter opens `Orchestrator › checkout-09`. Throwaway
state removed. Unfiltered type-check and zero-diagnostic lint (813 files), official
build, and gateway/attach/orchestrator tests (12 tests / 138 assertions) pass.

### Probe isolation correction

The probes above incorrectly used the default tmux socket and `tmux kill-server`,
which could terminate the developer's sessions. The developer explicitly forbade
this. Future probes must use a unique dedicated socket (`tmux -L <unique-name>`)
and clean up only the session they created. Never kill the default tmux server or
manage unrelated user sessions.

## Who owns a task, who hears about it, and how an orchestrator ends

The audit behind the `+` row, and the two controls the model was missing.

**One catalog, one authority.** The catalog is session-scoped to the root and
stays there: an orchestrator that admits work records *who asked* in `TaskInfo`,
but the task, its review, its evidence and its launch fence are written into the
root's catalog. A per-orchestrator catalog would split task identity and make a
projection read one orchestrator's tasks and not another's.

**Ownership is decided by the conversation, not by a list.** Environment tools
resolved their owner with `id === home.id ? null : ownerOf(id)`, so a *created*
orchestrator was not "home" and `ownerOf` threw — its `env_list`/`env_status`
could not work. `Runtime.taskOwnerOrNull()` now answers from the conversation's
own ownership: no owner means an orchestrator (root or created) and therefore no
task, an owned conversation still resolves to its task, and `ownerOf`'s refusal
for non-task conversations is unchanged.

**Completions go to whoever asked.** `tick` submitted every terminal task's
completion to the root, so a task admitted by a created orchestrator reported into
a conversation that never asked for it. It now submits to the admitting
orchestrator (`info.orchestrator`) and to the root only when that orchestrator is
gone — retired or never recorded — because a dropped report is worse than a
misdirected one.

**Rename and retire.** `orchestrator.rename` changes the title; `orchestrator.retire`
aborts whatever it is running and marks `retiredAt`. Retiring is *not* deletion:
the durable API offers none, and its transcript stays on disk. A retired entry
leaves `orchestrator.read`, the session catalog and the sidebar, stops being asked,
and its completions fall back to the root. The root itself can be neither renamed
nor retired, and a second retirement is refused. `frames.ts` validates both
responses.

**In the shell:** the sidebar forwards `r`/`d` on the selected row
(`WorkspaceNavigation` reports the row and intent, it never edits an identity), the
shell refuses any row that is not a created orchestrator with a notice, and
`OrchestratorDialog` asks for the new title or for explicit `y` retirement. State
is re-read only after the host answers; if the conversation on screen was the one
retired, the shell moves to the root. A session without a task also stopped
rendering as `Orchestrator › Orchestrator`: the root reads as one crumb.

Tests (`test/orchestrator-sessions.test.ts`, now 6): creation and refusal,
child nesting, a created orchestrator working in its own `cwd` with no task owner
while a task conversation keeps its owner, a completion landing in the admitting
orchestrator and not the root, and rename/retire including double-retire, root
refusals, the disappearing session and the root fallback report. Verified in a real
terminal on **an isolated tmux socket** (never the developer's default server):
`r` renames in place, `d` retires and moves to the root, the root row refuses with
a notice, and both survive a restart. Whole suite green — 115 files, 664 tests,
5837 assertions, 430 s.

## One creation request, one orchestrator; and no hidden truncation

**Idempotent creation.** `orchestrator.create` now accepts an optional
`requestId`; the registry stores it on the entry, and a replay returns the
orchestrator that identity already produced instead of creating a second
conversation. Creation is also serialised inside the process (`Orchestrators.create`
queues on one promise), because the authority is single and two submissions in the
same tick must not race two conversations into existence. A replay whose
orchestrator has since been retired is refused rather than navigating to a hidden
conversation. The chooser holds one identity per target — typing a different path
or picking another checkout makes a new one, retrying the same target keeps it —
so an ambiguous failure cannot duplicate on the next Enter.

Note for anyone adding a field here: `fields(input, [...])` in the client handler
rejects unknown keys, so a new input field must be added to that list; the
idempotency test caught exactly that refusal.

**Every child is listed.** The sidebar capped each orchestrator's children at 20
with no marker, which silently hid sessions. The cap is gone: the panel already
scrolls and follows the cursor, and `k`/`j` wrap the whole list.

Tests: `test/orchestrator-sessions.test.ts` is 7 — the new one submits the same
`requestId` twice concurrently, expects one orchestrator and the same identity
back, expects a *different* identity for the same intent to be refused by the
duplicate-directory fence, and expects a replay after retirement to be refused.
Verified in a real terminal on an isolated tmux socket with 26 orchestrators
seeded on disk: the tree lists them past the old 20-row limit and `k` scrolls to
the last one. Whole suite green — 115 files, 666 tests, 5843 assertions, 431 s —
and the official build and zero-diagnostic lint pass.

## A schedule remembers who asked for it

Item 1's last ownership question. Scheduled occurrences were admitted as the root's
children whatever orchestrator requested the schedule, and their completions went
to the root for the same reason: `Scheduler` was constructed with a two-argument
lambda, `(input, slot) => app.startTask(input, slot)`, which silently dropped the
attribution argument the scheduler already had in hand. Two things now hold:

- `Schedule.orchestrator` records the asking conversation at creation (the
  `schedule_skill` tool passes its own `api.conversationId`), and every occurrence
  is admitted with that attribution. The human approval that creates the schedule
  is unchanged and still the developer's.
- The runtime's `Scheduler` is wired with all three arguments, so the attribution
  reaches `TaskAdmission` and the completion routing added earlier.

The result is the same shape as a manually admitted task: a scheduled run is a
child of the orchestrator that asked, and its report lands there. A schedule
created before this change has no attribution and stays root-owned — nothing is
retroactively reassigned.

Test: `test/orchestrator-sessions.test.ts` now has 8 — a once-schedule created by
a created orchestrator is ticked, its occurrence appears as that orchestrator's
child, and the task carries the orchestrator identity. Whole suite green (115
files, 666 tests, 5843 assertions, 431 s), official build and zero-diagnostic lint
(814 files) pass.

## The orchestrator profile is a default, and a choice sticks

The configured `orchestratorProfile` is a default, not an assignment. Each
orchestrator conversation — the root included — may be given a profile of its
own, and once chosen it stays that conversation's profile until the developer
changes it again, across restarts and across changes of the default.

- `OrchestratorInfo.profileOverride` records a choice. The effective profile is
  `profileOverride ?? config.orchestratorProfile`; `read()` reports both, so a
  surface can show what it runs and whether it was chosen.
- Choosing configures that one conversation through its own `configure`, which
  is the same path a plain `session.configure` takes, and then records the
  choice. Two entry points therefore agree: the sidebar's `p` (a picker of the
  configured profiles, current one marked) and `/model-for <id> <profile>`.
- `Orchestrators.reconcile()`, run once at open, applies the effective profile
  to every orchestrator whose recorded profile differs from it. An orchestrator
  that never chose follows a changed default; one that chose keeps its choice.
  Nothing is reconfigured when nothing differs, so a restart is not a burst of
  commits.
- The root has no stored title or path, but its choice needs somewhere to live,
  so its record is stored like any other — and being stored does not make it
  renameable or retirable; both are still refused for the app's own
  conversation.

Two things this cost, both worth writing down. The root record means
`retained(id)` can now find the root, so the root refusals in `rename`/`retire`
moved ahead of the lookup to keep their messages true. And the first version of
the choice path used `commit((tx) => configure(tx, ...))` instead of the
conversation's `configure`; the two mutation-uncertainty tests in
`test/client-gateway.test.ts` hook `app.home.configure` and went from passing to
a three-minute timeout, which is exactly the kind of thing that would have
looked like flakiness later. It also threw on a default naming a profile the
config does not carry, which eight operator fixtures do on purpose — the
tolerance is back, and a stored choice whose profile has been removed leaves the
conversation untouched while still being reported, so it can be re-chosen.

Tests: `test/orchestrator-sessions.test.ts` is 10. A choice is observable in the
conversation's own model, survives a restart, outlives a change of default in
both directions, is reachable through `session.configure`, leaves the root
un-renameable, and refuses an unknown profile. Probed in an isolated tmux
socket: the picker lists the configured profiles with the current one marked,
`Enter` shows `Profile slow sticks to this orchestrator`, reopening reads
`now slow`, and a restart of the shell still reads `now slow`. Whole suite green
(115 files, 668 tests, 5860 assertions, 422 s), official build and
zero-diagnostic lint (815 files) pass.

## A direct environment action says who asked

The last of the three "who asked" gaps. `environment_action` — both the tool an
orchestrator calls and the TUI's direct Run/Build/Test — admitted its operator
task with no asker, so an action taken from a created orchestrator was
indistinguishable from one the root took. The tool dropped `api.conversationId`
at the call site and `Runtime.startEnvironmentAction` had nowhere to put it.

Now the asker is threaded through and fenced: `Orchestrators.attributing(id)`
accepts the root or a still-retained orchestrator and refuses an unknown or
retired one *before* any environment work starts, the client's
`environment.action` passes the acting conversation, and the tool passes its own.

Two deliberately narrow decisions:

- **The root is stored as absence.** An action from the root records no
  `orchestrator` field at all, so every existing root request keeps the record
  and the request identity it was saved under. The asker is part of that
  identity only when it is not the root, so replaying one `requestId` from
  another conversation is a conflict ("already used for a different environment
  action") rather than a silent adoption of the first task.
- **This is provenance, not navigation.** An operator task runs without a
  conversation — the skill task sets `TaskInfo.conversationId`, the operator
  task never does — so it has no transcript row to move; the shell's session
  catalog never lists it. The attribution lands in `state.tasks`, which is where
  the question can actually be answered, and it is what a report would use if
  operator results ever become messages (they are `reported: true` and stay
  silent by design: the developer watches the action in the environments view).

I had written the test expecting the row to move under the orchestrator and it
failed with `undefined` — which is how the "no conversation, no row" constraint
surfaced. The test now asserts both halves: the record carries the asker, the
session list never carries the task, and a root action leaves the record as it
was.

Tests: `test/operator-environment.test.ts` gained the attribution test (9 in
that file) and `test/orchestrator-sessions.test.ts` the fence test (11), which
refuses an unknown orchestrator with "not retained" and a retired one with
"retired". Whole suite green — 115 files, 670 tests, 5865 assertions, 464 s —
with the official build and zero-diagnostic lint (815 files).

## An orchestrator row says where it works

`Session` gained `path` for the orchestrator rows, so the sidebar can say which
checkout a row works in instead of printing a raw id (`Orchestrator 3`, which no
developer can use for anything).

The row shows the directory's **leaf** when that leaf is unambiguous, and
`parent/leaf` otherwise — two directories can share a leaf, and one directory can
hold two orchestrators. The shortening is done before the renderer sees it, with
a budget that keeps the leaf, because the renderer truncates from the right and
would throw away exactly the part that identifies the checkout. The first
attempt elided to the sidebar's own width and produced a double elision —
`…ntic-coding/agentic-codi…` — which hid the leaf; the budget now accounts for
the meta column.

The `+` chooser learned the same thing from the other side: it lists the
orchestrators that already exist, so a directory in use is visible before it is
chosen again. It is a note, never a refusal — a path is the agent's working
directory, not a lock, and the same directory twice is a legitimate pair of
conversations distinguished by their titles. Configured checkouts in the list
carry `· in use` for the same reason.

**And a defect the probe found:** typing `/` into the chooser's path field did
nothing. The key was bound as `{ key: "slash" }`, which never matches the
character a keyboard sends, so every separator was dropped — `…/other/api` became
`otherapi` — and an absolute path could not be typed at all; only the prefilled
directory and the configured rows worked. It is bound as `"/"` now, the same way
`LocationPicker` binds its search key. Space was bound the same way and did work,
so only the separator was affected.

Probed on an isolated tmux socket: the chooser notes
`already "Orchestrator" · a second is allowed` for the shell's own directory and
creates the second orchestrator; the sidebar then shows two rows with different
titles and the same directory, and an orchestrator in another directory shows its
own leaf. Test: `test/orchestrator-sessions.test.ts` (11) asserts the directory
travels with the session row. Whole suite green — 115 files, 670 tests, 5865
assertions, 426 s — official build and zero-diagnostic lint (815 files) pass.

## The transcript shows the transcript

The developer's report: opening a conversation showed local read chrome above the
messages — `Read context`, `▾ History · 0 loaded`, `Load newest page`,
`Read-only · up to 500 held, 20 shown · filters stay local.`, `2 older entries
loaded`, and a `Supplied local view details; not native authority` JSON dump.
None of it is the conversation, and none of it is what v1 showed.

- `src/tui/features/sessions/ContextPanel.tsx` and `HistoryPanel.tsx` are
  deleted. They were mounted only above the transcript and offered an explicit
  `session.context` inspection and a second, parallel `session.history` browser
  with its own filters, pagination and per-entry JSON dumps. The transcript
  already reads older pages itself, so the second browser was a duplicate
  affordance with a debug presentation; the protocol methods and their gateway
  coverage are untouched, only the TUI stopped surfacing them.
- `Transcript.tsx` lost its three status lines (`Showing the newest 200 entries.`,
  `N older entries hidden · scroll up to load`, `N older entries loaded`), its
  `Load history / Load older history / History exhausted` header and the
  transient `Loading history…`. Scrolling up still pages history in, and a failed
  read now restarts from the newest page on the same scroll-up gesture instead of
  stranding the reader without the header's `Restart history read` affordance. A
  failure still renders its message — an error is content, not chrome.
- The shell's generic `SuppliedObservation` block for `current().detail` is gone
  (label included), and with it the `SuppliedObservation` import in `App.tsx`.
  One page depended on that dump for real content: `/logs APP` on the
  environments page put the supplied output into `detail.logs` and had no other
  renderer, so it now prints the supplied text as plain lines instead of JSON.

Left alone deliberately: the `▸ Jump to a card · N` header and the two
supplied-integrity warnings (`Some cards share an identity and stay read-only.`,
`The saved card is not in this transcript.`) are affordances about the
conversation's own content rather than debug dumps, and the two
`SuppliedObservation` carriers for an unsupported assistant part and an unpaired
tool result only appear when the backend supplies something the transcript cannot
place. Visual acceptance of the cleaned surface stays with the developer.

## The response footer is one line

The developer's report: an assistant message carried `▸ Response details · 9 supplied
fields` (a fold over the whole supplied response metadata) and two summary lines
(`Assistant · "provider"/"model" · retained` and `Usage · <$0.01 · 3.9K→988 tok ·
cache 0/0 · reasoning 333`). The requested shape is one line:
`"opencode-go/deepseek-v4.1-flash" · <$0.01 · 3.9K→988 tok`.

`ResponseFooter.tsx` now renders exactly that: the model as one quoted
`"provider/model"` pair (bounded like every other supplied label, `not supplied`
when neither is present), then only the accounting actually supplied — `cost.total`
and `input→output tok` — and nothing else. The `Assistant · ` prefix, the
`retained`/`streaming` tail, the `Usage · ` prefix, `cache read/write` and
`reasoning` are gone from the line. The right-edge `Stamp` (request start and
recorded duration) and the `streaming`/`pending` suppression of a duration are
unchanged.

The `DetailsFold` with the raw supplied metadata, usage and timing is removed with
its `SuppliedObservation` carrier, so the message no longer has a raw JSON
inspection path in the TUI; the fold component itself stays (providers, resources
and observability still use it), and `ResponseFooter` lost its now-unused `scope`
and `interactive` props. Reasoning remains a subset of output and `cacheWrite1h`
a subset of `cacheWrite` — neither was re-added, and nothing is estimated. The
`ReportedUsageModal` (the ported cost modal) is untouched and still shows the full
supplied accounting on demand.

## Opening a conversation lands on its newest entry

The developer's report: opening a transcript could land somewhere other than the
newest message — on a saved scroll offset, or on a deep local window left over
from an earlier visit. The requested rule: always show the latest entry when the
view opens.

The transcript restore in the shell's post-render settle no longer honours a
recorded offset. `pendingTranscriptRestore` now carries only the exact target
identity (page, resource, session id); when it matches the mounted transcript the
shell clears the reading place, sets `followingBottom`, clears `awayFromBottom`
and scrolls to `scrollHeight - viewport.height`. A saved `View.scroll` is still
recorded by `remember()` and still restores ordinary list/resource pages — it just
no longer decides where a conversation opens. Reading back stays a gesture the
reader makes: scrolling up keeps paging in older history exactly as before, and
the `JumpToLatest` affordance is unchanged.

Two consequences worth naming. A pinned viewpoint's `transcriptFollow` flag is now
vestigial for opening (every open follows); it is still recorded when a viewpoint
is pinned, so the pin keeps describing what it captured rather than being
silently rewritten. And the deep-position branch is gone with the offset: the
shell no longer calls `expandAll()` to rebuild an old scroll bound, because the
open always targets the end of the newest page. Visual acceptance of the settle
order (streaming, window growth, resize) stays with the developer.

## One footer per input, not per response

The developer's request: the footer should appear once per *input* — once per user
or workflow message — and report that input's stats, instead of after every
assistant turn.

`src/tui/features/sessions/turn-stats.ts` groups the rendered messages: a `user`
message opens a group, and every following `assistant` response belongs to it
(`toolResult` rows belong to the group but are not responses). For each group it
sums the *recorded* `usage.cost.total`, `usage.input` and `usage.output`, collects
the distinct `provider/model` identities in first-seen order, and keeps the last
assistant record for the request stamp. Nothing is estimated: a field that was
never supplied stays absent, and a group answered by several models names each of
them (`"p/m1, p/m2"`). Reasoning is still a subset of output and `cacheWrite1h` a
subset of `cacheWrite`, so neither is summed in again.

The summary is carried by the group's last *rendered* message, not by its last
assistant message, so a trailing tool result does not leave a footer stranded
above it. `ResponseFooter` takes that aggregate instead of a single message: one
muted line — `"provider/model" · summed cost · summed input→output tok` — with the
recorded request stamp of the group's final response on the right edge. The
aggregation lives in its own module because it is pure presentation logic over
supplied messages; a throwaway script confirmed the grouping (two responses in one
input → one footer on the last message: `$0.01 · 3000→500`, a trailing
`toolResult` carrier, an assistant group with no preceding user message, and a
group with no assistant response emitting nothing). No helper/renderer test was
added, per the testing agreement.

Environment note from this pass: the first full-suite run after the footer change did
not finish — it stopped responding after 618 passing tests, inside
`test/lifetime-identity.test.ts`. Seventeen orphaned fixture
`kubectl … logs --follow` watchers from earlier (aborted) runs were still alive,
one per dead `ac-v2-test-*` temp dir, exactly the leak recorded in
`docs/backend-acceptance.md`. With those reaped, the same file passes alone in
4.8 s and the full suite passes 673/673 in 419 s. This is an observation about a
dirty fixture environment, not a diagnosis: the watcher leak makes a full run
unreliable on a machine that has been running suites for a while, and it remains
unclaimed in the fixture teardown.

## Test-cost consolidation

The developer rejected real-deadline waiting tests and full-stack setup per input
permutation. After the previously committed SQL/HTTP deadline and container/Compose
suite removals, this pass removes bridge startup-expiry variants and the probe
poll-count scenario, reduces the Docker/Podman lifecycle cross-product, and removes
two overlapping topology cancellation/owner-queue scenarios. Distinct agent and
operator admission paths, re-add approvals, host-anchor survival, and unique
ownership/recovery refusal cases remain.

Fixture repositories now copy an in-memory initial Git repository rather than
spawning five Git setup commands per test. Every checkout, index, config and object
store remains an independent file copy; a disposable real-Git check verified that
committing and changing config in one repository leaves its sibling clean and
unchanged. Configuration-only migration cases now use `definition()` without
opening a runtime. Seven Helm schema variants share one definition while each
mutation gets its own document copy. `test/README.md` records the cost rules.

Verification: unfiltered type-check and lint clean; official build clean. Full
serial suite: 608 pass, zero failures, 251.20 seconds, versus the earlier measured
673 tests / 423.52 seconds before all removals and consolidation. This is not a
one-minute suite yet. No production behavior, timeout, retry policy or default
coverage selection changed; the removed cases are no longer covered by those
integration scenarios.

## Test-cost consolidation, second pass

Removed the SQL success/function-write outcome and read-only credential-rotation
cases that `container-sql.test.ts` already asserts, keeping the live-authority,
cancellation and crash/reopen boundaries in `query-lifecycle.test.ts`. Combined the
per-variant container SQL and endpoint-authority refusals into one live setup per
file that restores the fixture engine between checks, instead of one runtime, engine
and disposable database per variant. Folded Helm Availability readiness and the
re-add live-unit/extra-field refusals into the lifecycle scenarios that already hold
the same host. Batched effect-free validation inputs — topology candidates, bridge
staging and operator admission refusals — over one authenticated host and one
definition each, which is where nearly all of their measured time went.

Two waiting mechanisms were replaced rather than shortened: engine startup is now
held by an explicit fixture gate the test releases, and a port forward is terminated
by its own pid observation, so no test waits a chosen duration. The unused
build/inspect/start delay knobs and the timed forward exit were deleted.

Verification: unfiltered type-check, lint and the official build are clean; the
complete suite is 573 tests in 234.74 seconds with one timing-sensitive assertion
fixed afterwards. The one-minute goal is still unmet. The remaining time is
distributed across genuinely distinct lifecycle scenarios at roughly 0.35 seconds
each, not concentrated in a few files, so reaching it would require deleting unique
integration coverage rather than further consolidation.

## Test-cost consolidation, unit-first pass

The developer directed a further cut to about one minute, with unit tests preferred
and real-infrastructure testing reduced to a minimum. The complete suite is now 363
tests in 62.46 seconds with zero failures, from 573 tests in 233.39 seconds and 673
tests in 423.52 seconds.

Converted to deterministic unit tests, replacing the integration versions:
retained-diagnostic windowing, boundary cursors, exact-ID reads and their scope
refusals (`diagnosticHistory`), and Compose command quoting, environment-array and
published-port parsing. Both run in milliseconds and assert the same rules the
expensive suites exercised through a gateway, engine and disposable database.

Deleted as redundant with a kept representative or as infrastructure plumbing:
container SQL success and container/pod endpoint authority permutations, the
SQL-to-crash lifecycle file, the prerequisite-bridge, topology, operator
infrastructure/re-add/host-anchor/environment and cross-repository prerequisite
suites, the Helm release suite, the Kubernetes pod, diagnostics and deployment-loss
suites, shared diagnostics, canonical wait expiry, telemetry receivers, offline
environment migration preview, and the tree-release/independent-recovery crash
files. Representative scenarios were kept for task admission, one held SQL
diagnostic with TLS refusal, one held HTTP diagnostic, one container lifecycle, one
Kubernetes pod lifecycle, one local cluster, one shared crash/reopen, and the
gateway client.

Guarantees that lose direct automated assertion, and are now reviewed manually:
per-operator-unit stop/re-add/host-anchor authority, prerequisite bridge sharing and
foreign-attachment refusal, network-only topology lifetimes, Helm release identity
and uninstall scoping, pod port-forward and deployment-loss fencing, telemetry
receiver/codec behaviour, and offline migration preview output. The production code
is unchanged; nothing was weakened to make a test pass.

## Test-cost consolidation, unit-first extreme

The developer asked for the fastest defensible suite and accepted that the
one-minute figure is a direction, not a bound. The complete suite is now measured
below; every remaining test is either a pure unit test or a cheap fence/validation
test measured in tens of milliseconds.

Removed the last runtime-bound suites: shared crash/reopen, host-build Maven
extraction, environment lifecycle, Kubernetes pod/replica/service lifecycles, tree
interruption and mutation, CLI, held HTTP and SQL diagnostics, cross-repository
Compose, Podman networks, lifetime identity and sharing, transcript observations,
providers and workbench, schedules, system shell, environment idle, gateway client,
telemetry, profile parity, cluster namespaces, config, dependencies, staged tree,
orchestrator sessions, endpoint/kubernetes binding fences, operator revocation,
reference journal, HTTPS, migration preview, and cluster status.

Added pure unit coverage for the rules those suites used to reach through a stack:
transcript token/cost/duration formatting, one-footer-per-input usage summation with
non-finite omission and multi-model labels, and Kubernetes pod-target refusals
(system/default namespaces, chart-owned fields, port-forward port, duplicate local
ports, replica selection). Together with the earlier Compose parsing and diagnostic
history unit tests, the deterministic core of the removed suites is still asserted.

Guarantee that is no longer asserted automatically: the wiring of any adapter that
calls these validated functions, the durable admission path for a real task, and
every live resource lifetime. That is now manual acceptance and is recorded here
rather than implied. Production code is unchanged.

## Closing an orchestrator session

The sidebar could already fence a created orchestrator under the word `d` **retire**, but the name and the dialog implied something softer than what happens: the session ends. It is now **close** everywhere the developer meets it — the `d` binding and its footer label, the palette command `workspace.close`, the confirmation dialog, the notices and the protocol method `orchestrator.close` (which replaces `orchestrator.retire`; the persisted field keeps the name `retiredAt`, so sessions closed under the old name stay closed).

The dialog now states the whole consequence: the session leaves the sidebar, nothing can be asked, reported or sent to it again, its transcript stays on disk, running work it asked for is stopped, a new orchestrator has to be created to continue in that checkout, and this cannot be undone. `test/orchestrator-close.test.ts` asserts the part that is a promise rather than a sentence: the closed conversation is not listed, it is not addressable, closing it twice is refused, and the same checkout accepts a fresh orchestrator afterwards.

Closing is a fence, not a deletion, because the durable API offers neither a conversation delete nor a replacement root. That is also why the reserved root cannot be closed: it is the conversation every unattributed completion and every schedule occurrence reports through. Selecting the root and pressing `d` says so and names the path that does work — create an orchestrator for the checkout with `+` and close that one. Live tasks admitted by a closed orchestrator are not cancelled: their completions fall back to the root, as the completion path already did for an orchestrator that is gone.

## `q` and Ctrl+C twice did not exit the client

The shell owned exactly one exit key, `Ctrl+Q`, and it opened a confirmation dialog. v1's global exit — press `q` twice, or `Ctrl+C` twice, within a second — was never wired into the shell: the environment feature still *advertised* it (`Press q twice to quit.`), and its own layer deliberately hands `q`/`Ctrl+C` to the host when embedded (`hostOwnedKeys`), so on the environment surface the keys reached nothing at all. `hostKeys.ts` even documents "Quit is the shell's, on every surface".

The two keys now dispatch from their own layer, `v2.quitKeys`, at priority 5. The priority and a precise `enabled` predicate are the whole design: a *bound* key is consumed before the renderable that expects to type it, so a global `q` binding would have stopped the letter `q` from ever reaching a textarea. The layer therefore stands down whenever `renderer.currentFocusedRenderable` is a `TextareaRenderable` (`InputRenderable` extends it, so feature inputs are covered too), and while the help, palette, settings editor/theme picker, any shell dialog or picker, an environment modal, or an embedded agent terminal holds the keyboard. `quitKeybinds` lives beside `shellKeybinds` for the footer and `?` catalogs but is deliberately *not* dispatched from the shell layer.

The first press publishes v1's own sentence — "If you want to quit press q again" / "If you want to quit press Ctrl+C again" — and arms a one-second local window; the second press exits with status 0. Either quit key satisfies the window, as in v1. `Ctrl+C` with a terminal selection copies it and clears the arming instead of exiting, because the selection is what the developer is acting on. `Ctrl+Q` keeps its confirmation dialog; nothing about it changed.

Verified in a real tmux terminal (`tmux -L acv2quit…`, 150×40, throwaway config/state, socket and directories removed afterwards): `q` `q` exits with `EXITCODE=0` after showing the notice, `Ctrl+C` `Ctrl+C` does the same, and `qqqq` typed into the new-orchestrator path input stays in the field with the client still running.

## The transcript's own meter and its two bulk toggles

The prompt footer had replaced v1's `contextMeter` with a scope hedge — `window $0.01 · tok 1.2K→300` — losing the one number the footer exists for. It reads v1 again: active context, then cost, then tokens (`63.9K (6%) · $0.01 · tok 1.2K→300`). Active context is the newest generation's prompt — input plus cache reads and writes — taken from the committed entries; a streaming partial carries no usage, so nothing is estimated mid-generation. The share appears only when the catalogue supplies that model's window, which is why `Transcript` now carries `contextWindow: number | null` resolved server-side from the same catalogue the pickers read; an uncatalogued model drops the percentage instead of inventing a denominator. The trailing token totals stay what they always were: the returned history window, not a lifetime figure.

`Ctrl+T` and `Ctrl+O` are the transcript toggles again. v1 folds every thought, or every tool card, at once: the first press expands the whole kind, and one open card is enough to make the next press read as "collapse", so a half-expanded kind never needs two presses with different meanings. v2 had `Ctrl+T` opening a view in a new tmux window and `Ctrl+O` toggling a single selected card; the per-card toggle moved to `Ctrl+Alt+T` and is listed in `?`. The keys work because the transcript layer already sits at priority 30 above the shell's 10, and `@opentui/keymap` sorts registered layers by descending priority — checked in the library source (`right.priority - left.priority`) rather than assumed.

Which keys a footer may advertise is now one predicate. `transcriptKeys()` gates the transcript layer's `enabled`, the transcript's own chips, and the shell's `Ctrl+T window` chip, so a chip can never name a key another layer consumed first: with the transcript holding the content the footer offers `thoughts` and `tools`, and moving focus to the sidebar hands `Ctrl+T window` straight back. Before that, the footer showed both keys at once.

The fold rule is a pure pair — `bulkFold` decides "close a half-open kind", `foldAll` merges the result while leaving a card's own section folds and every other session's state untouched — and is pinned in `test/presentation-rules.test.ts` together with the meter's exact strings. The dispatch and chip halves were confirmed in a real tmux terminal (throwaway config/state, socket and directories removed afterwards); a fresh state has no orchestrator session, so the transcript page with its chips and folds still needs the developer's own visual pass against a live session.

## Timing and the compaction the footer never mentioned

Two readings were missing from the meter restored above. v1 also printed the completed generation's rate — `42.7 tok/s` — and, while a summarization ran, `compacting (manual)` or `compacting (automatic, retrying)`, which is the only thing that explains a session that has gone quiet. Both come from records v2 already carried: `progress.compactions` was in the transcript payload and was rendered nowhere as a live state, so a running compaction looked like a stall until it either finished or wrote a failure row.

The rate pairs one message's own output with that same message's recorded duration, to one decimal. That pairing is the point: v1 read the output from the usage document and the duration from a separate timing document, and v2's entries record both per message, so a rate can never mix one generation's tokens with another's duration. A streaming partial and a message whose duration was never recorded report no rate rather than an invented one — and because the entries are the source, the same function now also feeds the per-turn footer, which gained `tok/s` beside its cost and input→output totals.

The compaction indicator reads the first supplied live record that carries a reason. `manual` is printed only when the source says `manual`; every other supplied reason reads `automatic`, exactly as before, and a supplied retry record carrying an error adds `, retrying`. The error text stays out of the footer — it belongs to the records and the failure row — and nothing about the indicator is inferred: no record, no indicator.

`generationSpeed` lives beside the other per-turn metrics in `turn-stats.ts` because two surfaces read it; `lastAssistantMessage` and `runningCompaction` sit with the meter. All three are pure and pinned in `test/presentation-rules.test.ts`: the exact footer order (`context · cost · tok · tok/s · compacting`), the reason mapping including the retrying marker, that a partial or undated generation reports no rate, that the newest assistant message wins over a trailing tool result or user turn, and that a compaction record without a reason is not a running compaction.

## Which tools read as themselves, and which read as a bare name

v1 gave every tool it knew its own card. Checking that against v2 turned up an answer worth writing down, because it is not "port the rest": v1's families are all present — `read`, `write`, `edit` (retained diff, requested replacements, added/removed counts), `bash`/`shell`/`execute` (command, timeout, bounded output), `codemode` (script headline, retained script output, nested slots), `developer_question`/`agent_ask` (questions, options, answers, warnings) — and its last one, `ask_jev`, cannot appear in a v2 transcript at all. That tool's wire name is `n`, v1 registered it as its own in-session judgment tool, and v2 registers no such tool: porting its view would have been a card for a call nothing can make.

What the survey did find is the opposite gap. v2 has tool families v1 never had — the orchestrator's own (`start_task`, `environment_action`, `task_result`, `cancel_task`, `catalog`, scheduling), the environment tools (`env_*`, `otel_query`, `db_query`, `http_request`), evidence and review, the workflow and stage tools — and those rendered as a bare tool name twice over (`label` was the name, and `hint` repeated it) with no icon at all, because the icon map predated them.

`tool-presentation.ts` now names them, purely: an icon per family (exact name first, then the family prefix, so a new `env_*` tool needs no entry), a line that says what the call does and what it acts on, and a hint for the target. The families that own their header keep it — the module refuses `read`/`write`/`edit`/`patch`/`bash`/`shell`/`execute`/`codemode`/the two dialogue tools and every `browser_*` call, so nothing that already worked changed. Verbs are spelled for the call's phase, so an unreturned `start_task` reads "Starting review-runner", never as a completed one.

Four families earn an exact reading rather than the generic one: `http_request` is `POST /v1/requests` with the app as its target (`GET` when the call supplied no method), `db_query` is `SQL · <database>` with the statement's first non-blank line as its hint, `start_task` names the skill and the checkout and policy behind it, and `environment_action` reads as the action it prepares on the apps it names (`Build api, web`). Evidence names the file it retained and keeps the caption as its description. Everything else states its own name and target exactly once, and an argument the call never supplied is never invented.

Every supplied label is bounded like the rest of the transcript. The module is pure and pinned in `test/presentation-rules.test.ts`: the owned families return nothing, the pending/done verbs, the two diagnostics readings including an empty first SQL line, that an unknown tool reports its name and no hint, and the icon of each family including the `•` an unrecognised one falls back to.

## The per-family result projections were real, and they are ported

The survey above said v2's own families had no v1 counterpart. That was wrong, and the correction matters: v1 keeps a second module beside `tool-views.ts` — `custom-tool-views.ts`, 779 lines — that projects results for exactly the families in question, on top of `tool-content.ts`'s shared primitives (value rows, content rows, status rows, defensive credential redaction). A search's matches were grouped by file, an HTTP response showed its status, headers and body, a query rendered its supplied columns as a table, a trace kept its children beneath their span, a workflow kept its report apart from its arguments, evidence kept its artifacts. v2 rendered all of them as one joined text blob or a bounded JSON explorer.

`custom-tool-view.ts` is that projection, ported. It stays pure: it takes the call's name, arguments, returned text and recorded details and answers with a label, a hint, rows and independently foldable sections — no transport, no execution, no live resource, nothing inferred. `CustomToolBody.tsx` draws them with v2's own primitives: `SuppliedCode` for supplied source and markdown, `DetailsFold` per section, a width-measured table for supplied cells, tone-carried rows for status/severity, and nested records behind their own disclosure so a deep result never becomes a wall of text.

The families: search (grep/glob/find/ls), web fetches and searches, environment (`env_*`, including the cluster tools), build/test/logs output, HTTP (`http_request`, `stage_api_request`), queries (`db_query`), telemetry (`otel_query`, `browser_console`, `browser_network`), stage runs with one section per step, workflow and list tools, events, evidence, sessions/debug, and the orchestrator's own (`catalog`, `start_task`, `task_result`, `cancel_task`, `request_review`, `environment_action`). Browser actions and browser scripts are deliberately left to the card's existing observation and retained-script-output folds: those are already projections with their own sections, and re-projecting them would have shown the same result twice.

Three properties came across unchanged, because they are the reason the module is worth having: an error envelope is never read as a domain result (a failed call renders its Error section instead of pretending the payload is a response), a `browser_fill` value and every secret-shaped field or query parameter is redacted before it reaches the screen, and the projection is *additive* — the card's "Complete retained output", retained-parts and complete-argument folds are untouched, so nothing the projection consumes becomes unreachable.

The projection answers first for label and hint; `tool-presentation.ts` still names the families it does not cover and supplies every icon. Pinned in `test/presentation-rules.test.ts`: matches grouped by file with line numbers and a line the pattern does not explain left alone, an HTTP status toned by class with redacted headers and a JSON body drawn as JSON, a supplied column order preserved in a table, a failed call rendering an error section rather than a result, a log's exit code only when recorded, a span's own fields staying beside its children, and every non-projected family still returning nothing at all.
