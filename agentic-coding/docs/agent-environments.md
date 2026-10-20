# App run slots

An app runs **once at a time**. Its slot is held by exactly one owner (`user` or
`workflow:<id>`) and the app runs from that owner's checkout with the
definition's own static names, ports and image references. Routing, OAuth
redirect URLs and proxy configurations all assume static ports, so nothing is
templated per run: agents that need an app another owner holds **wait for it**.

## The slot

- One active instance row per app (state schema v9; `env_instances` with a
  unique partial index on `app`). The row records the holder, the run target,
  the checkout path and the status.
- All runs of one workflow share that workflow's slot: a workflow has one
  checkout. A repeated start by the current holder answers `already-running`
  and starts no second copy.
- The durable storage key is app-scoped; the user-facing id for a human-held app
  is `default`, while workflow ids are sanitized, stable slugs with a short hash
  suffix.
- Owners are `user` or `workflow:<id>`. User runs use the app's active checkout.
  For workflow owners the server resolves the recorded workflow repository or
  worktree, or finds the workflow branch in the managed app worktree; clients
  cannot submit a checkout path. An optional configuration overlay is searched
  ahead of the live configuration directory.

## Occupancy

A slot is occupied when an active row exists **or** run observation reports a
run target of the app running. A run observed without a row is reported with
holder `user`, so agents wait for the developer's own run. Unobservable state
(runtime unavailable, observation failure) counts as occupied: observation
failure is never absence. Reconcile keeps such an instance `unknown`, which
blocks the slot until reconcile confirms it gone or the developer force-releases
it.

## Waiting

A start that names one or more apps for another owner's app waits in a per-app
FIFO queue ordered by one global sequence:

- The start request long-polls (`waitSec`, at most 300 s) and answers `waiting`
  with the 1-based position and the holder per app when the time elapses. An app
  that is merely ahead of a request in queue order is not named as a holder.
- A repeated request by the same owner for the same apps within 60 s keeps its
  queue position; after the grace the entry expires. A long poll that is still
  running is never expired out from under its own request, and one entry has
  exactly one poll loop: a second concurrent request for the same owner and apps
  joins it instead of racing it.
- A multi-app request is one entry. It is granted only when every app is free
  **and** the entry heads every one of its queues (an app the owner already runs
  needs no position), so a partially free request starts nothing.
- Before enqueueing a request is given its wait edge and the wait-for graph is
  then checked: if following holders and their waits would reach the requester,
  the entry is withdrawn and the request fails with `deadlock`, naming the
  cycle. Enqueueing first is what makes a crossing pair detectable — the request
  that publishes its edge last sees every earlier edge. `user` never waits, so
  the developer can never close a cycle.
- A waiting owner keeps the slots it already holds: a long poll refreshes the
  activity stamp of the holder's rows at most once per second, and the slots
  list names the waiting owners, so an idle lifecycle never reaps an app the
  owner still needs.
- Run observation is re-run on its own cadence (about once a second), not on the
  25 ms queue cadence, and discovered run targets are reused for a moment: a
  wait never spawns `tmux` or walks the config tree per poll turn.
- A release that lands while an owner's poll is in flight is delivered, not
  undone: the poll consumes the notice and answers `released-by-developer`
  instead of restarting the app the developer just took away.

## Lifecycle

An app is held until its owner stops it or until it sits idle, so nothing an
agent forgets can block the queue forever.

- **Owner-bound release.** Closing or deleting a workflow emits the durable
  `environment.teardown { workflowId, owner }` effect, which calls
  `POST /api/v1/environment/apps/teardown { owner }` and stops every app that
  owner holds through the normal stop path. An unreachable server is an
  `infrastructure` failure: the outbox retries it, and a release is never
  recorded as completed without an answer. A process with no environment server
  at all fails permanently instead of retrying forever — no retry attaches a
  transport. `user` is refused: the developer's own runs are never released by a
  workflow lifecycle.
- **Ordering.** A close enqueues the teardown *before* the `workspace.cleanup`
  its close effect queues, because a stop runs from the workflow's own checkout:
  removing that first would leave a run nobody can stop.
- **Delete.** The delete removes the workflow's rows — and its outbox — with it,
  so it drains the teardown first within a bounded window and reports
  `teardownError` on the deletion when the server did not confirm the release.
  The delete itself still happens; the report is what keeps the release honest
  instead of silently forgotten.
- **Activity.** `last_activity_at` is written by any operation on a held app.
  Writes are coalesced to one per app per 30 s, and a waiting owner refreshes
  the rows it holds at most once per second while it long-polls, so an app in
  active use never looks idle.
- **Idle reaper.** One server-scoped reaper runs every 60 s and stops
  agent-held apps that have been idle longer than
  `environment.instances.idle_ttl_minutes` (default 30). It skips an app in
  `unknown` state, an app held by `user`, and an app held by an owner that is
  currently waiting for another app. A reap goes through the normal stop path,
  so the queue grants the next waiter on that waiter's own next poll, and it
  publishes `environment.slot.reaped { app, owner }` for the shell toast.
- The setting is file-only: `environment.instances.idle_ttl_minutes` in the
  layered workflow configuration (`$AGENTIC_CODING_CONFIG_DIR/config.json`),
  re-read on every reap pass. An unusable value falls back to the 30-minute
  default instead of disabling the lifecycle.

## Instance variables

The server passes these values to Compose interpolation or the script process:

| Variable | Value |
| --- | --- |
| `AC_OWNER` | `user` or `workflow:<id>`. |
| `AC_APP_DIR` | Checkout path bound to the slot. |

Nothing else is templated. `AC_PORT_*`, `AC_INSTANCE` and `AC_IMAGE_TAG` are
gone: Compose runs with the file's own project name, container names and host
port mappings, and image tags are whatever the definition says. There is
therefore no `untemplated-target` refusal any more — a fixed `container_name`,
`ports:` mapping or `include:` directive is valid for every owner, because only
one copy ever runs. Docker runs use the definition's Compose project; script
runs are tracked with an instance-specific process/tmux handle, so stopping one
app does not stop another. Workflow-owned scripts run as logged child processes
even when the server itself is inside tmux, so they do not inherit the tmux
server environment; their process environment is an allowlist of runtime
settings plus the `AC_*` values above. User-owned scripts retain the operator
environment except server capability variables. If no target/profile is named,
selection prefers Docker and then shell/system-shell; Kubernetes is not
implicitly selected.

## Kubernetes runs (opt-in)

A Kubernetes target starts only when it is asked for by name — `runtime:
"kubernetes"`, or the target's id/label through `target` — and it holds the
app's single slot like any other runtime. It exists for one job: a bug that only
shows with several replicas (locking, caching, scheduled jobs, session
affinity). Everything else should stay on Docker; kind is heavy and the cluster
run is the slow path.

- **Replicas.** `replicas: <n>` is applied as the Helm value the target names in
  `replicasValuePath` (`config/apps/k8s/<app>/devenv.k8s.json`), defaulting to
  `replicaCount`. Without `replicas` the chart's own default applies. A request
  that asks for replicas of any other runtime is refused with
  `replicas-unsupported` rather than silently started once.
- **Cluster is a precondition.** The start lists the clusters and fails with
  `cluster-unavailable` when the configured one (`devenv` by default,
  profile-scoped as `devenv-<profile>`) does not exist. A cluster is never
  created implicitly: create it yourself
  (`kind create cluster --name devenv`) when the run is wanted.
- **Static identity.** The start installs the target's own release into its own
  namespace with its own values files, and starts the target's declared
  port-forwards as managed processes. The chart's image is the target's own
  value: a run neither builds an image nor applies secrets.
- **Stop.** Stopping the run tears down the port-forwards first and then
  uninstalls the Helm release (`helm uninstall <release> --namespace <ns>
  --ignore-not-found`), so the app's slot is only released once the cluster
  side is gone. A start that fails after the install cleans its release up
  again instead of leaving it behind.
- **Observation.** A Kubernetes release is not a process of the server, so the
  script-handle observation never applies to its row: a persisted row holds the
  slot, and whether its pods are there is what the app's runtime status reports.

## API

| Route | Meaning |
| --- | --- |
| `POST /api/v1/environment/apps/acquire` | `{ owner, apps[], target?, profile?, runtime?, replicas?, waitSec? }`; answers `started`/`already-running` with the held instances, `waiting` with positions and holders, `released-by-developer`, or fails with `deadlock`. `runtime: "kubernetes"` with `replicas` is the opt-in cluster run; replicas of any other runtime are refused (`replicas-unsupported`) and an absent cluster fails with `cluster-unavailable`. |
| `POST /api/v1/environment/apps/{app}/release` | Developer force release: stops the holder's run, leaves it the `released-by-developer` notice, and lets the queue grant the next waiter. |
| `POST /api/v1/environment/apps/{app}/stop` | Stops the app's current run without the notice. |
| `POST /api/v1/environment/apps/teardown` | `{ owner }`; stops every app that owner holds through the normal stop path and answers the apps it stopped. Idempotent, and `user` is refused. |
| `GET /api/v1/environment/apps/slots` | Every configured app's `holder`, `status`, `waiters`/`waiting` (each with wait start and queue position), `holderSince`, `idleMs`, `idleTtlMs` (agent holders only) and `endpoints`. |

`endpoints` report the definition's declared endpoint exports (Kubernetes
targets). A Compose target's ports are its own static mapping, so there is
nothing dynamic to report for them.

The holder's next call after a force release answers `released-by-developer`
once and then starts cleanly.

## Environment setup workflow

The `env-setup` family authors an app's environment definitions as drafts and
publishes them only after the developer approves them:

```text
agentic-coding workflow start --workflow env-setup --repo PATH --mode checkout \
  --app IDENT --workflow-id ID [--task TEXT]
```

- **A staged configuration root, never the live files.** At the first author
  turn the system materializes a complete working configuration root at
  `<config>/.drafts/env-setup/<workflow-id>/root`: the live configuration
  copied at its own relative layout (`apps/build/*`, `apps/run/*`,
  `apps/compose/*`, `apps/kubernetes/<app>-<profile>.k8s.json`,
  `infrastructure/definitions/*`, `infrastructure/compose/*`), with the
  author's files written at their final paths. The app repository is read-only
  evidence; the staged root lives outside the checkout.
  - Live **symlinks are preserved** as absolute symlinks to the same target
    (`apps/build/<app>-build.Dockerfile` → `~/devenv-config/...`), so the gate
    exercises production's symlink behaviour instead of papering over it. A
    staged path that is a symlink therefore *is* the developer's own file: the
    author instructions say to delete the staged link and write a regular file
    rather than write through it, and `env_list` reports those paths and their
    targets (`stagedSymlinks`) so the choice is visible before anything is
    written.
  - `.env` and `providers/` are exposed **read-only**: private copies (mode
    0o400) inside the workflow's own 0o700 state directory, never symlinks and
    never in the repository. A symlink would be write-through — a stray write
    from a drafted script would rewrite the developer's live `.env` before
    approval — and the promotion's prefix allow-list makes them unpublishable
    either way. `base.json` records per-path digests and symlink targets, never
    secret content, and is authenticated with the run's pinned promotion
    secret.
  - `wiki`, `telemetry`, `snapshots`, `.drafts` and `.backups` are not copied,
    and neither is the server's own live state and caches — `orchestrator/`,
    `.agentic-coding-workflow/`, `classifier*` (a 342 MB classifier install in
    the motivating configuration) and `browsers/` (the product's Playwright
    install). The walk is bounded (20 000 entries, depth 12) and a
    configuration above the size bound refuses the start instead of filling the
    disk.
- **Drafts are runnable and promotable as drafts.** Discovery, compose/docker
  invocation and every `env_*` tool of the workflow's runs resolve the staged
  root as if it were the configuration root, so a draft written with
  `include: ../../infrastructure/compose/x.yml` works exactly as it will after
  promotion. The **changed files** are derived by comparing the staged root
  with the base snapshot, so the live configuration's own 78 symlinks never
  read as drafts; a changed symlink is a non-regular finding and a deleted path
  is a finding that is never published.
- **Write guard.** The configuration's *definition* trees (`apps/`,
  `infrastructure/`, `libraries/` — every tree a draft may publish into, plus
  the library definitions) and the checkout are fingerprinted before the first
  author turn; at every author handoff the guard compares them and a change
  inside those trees fails the guard, which parks the workflow in
  `attention-required` with the violation naming the changed paths (bounded)
  and how many changed. The developer decides what happens next. The scope is
  the fix for the first real run: fingerprinting the whole configuration
  directory failed closed on the server's own state (`orchestrator/**`,
  `classifier/**`, `.agentic-coding-workflow/**`, `tui.json`) and on the
  product's browser install, whose tree is deeper than the walk's bound, so a
  correct workflow parked every time. A symlink inside a checked tree also
  records its resolved target *and* the digest of what that target holds, so a
  write through it into the developer's own repository is caught and named.
  Inputs are fingerprinted, not just paths: a byte-identical restore (the
  promotion's own rollback, a `touch`) is not a change.
- **Deterministic validation of the real path.** `setup.validate` parses every
  draft, checks that discovery resolves each drafted run target, compiles them,
  requires the `AC_OTEL_*` wiring, refuses a host port another app already
  declares, lists referenced `${VAR}`s the configuration `.env` lacks, and then
  runs the real developer path **against the staged root**: the **default
  build**, the app's **default run target** to readiness, the **default test**
  when one exists, and `docker compose config -q` on every modified shared
  infrastructure definition. Every step is reported with its exit status and a
  bounded log tail, the default target per action is named **with the reason it
  was resolved** (declared / only candidate / preference), and two candidates for
  one default-profile build/test target are an explicit `no-default-target`
  finding rather than a silent pick. The steps run the targets the gate
  *resolved*, so "what the gate validated" and "what runs" cannot drift apart
  inside the gate itself. A step the machine cannot run (no docker
  daemon, no `docker` CLI, an unreachable Kubernetes cluster) is a visible
  `skipped` finding and fails the gate, never a pass. Each step also has a
  deadline and the gate a wall-clock budget: a hung build is stopped and
  reported, and the step that spent the budget is named. A failure returns the
  report to the author, bounded to five rounds. The gate records the digest of
  every drafted file it validated in the workflow's own snapshot, so the
  promotion refuses to publish anything else.
- **Approval.** `setup.approval` shows the developer every new and modified
  file as a unified diff against the live configuration, flags a change to an
  existing shared service definition as *affects all apps*, and offers approve
  (promote) or request changes with comments (back to the author). A drafted
  default declaration (`apps/defaults/<app>.json`) renders as the decision it
  is — `# default build for <app> = "<target>" (was ambiguous: docker, shell)` —
  and is backed up, promoted and rolled back like any other drafted file.
- **Atomic promotion, conflict-safe.** `setup.promote` backs up every replaced
  live file to `<config>/.backups/env-setup-<workflow-id>/`, writes each file
  through a temporary sibling renamed over its target, reloads the environment
  catalog, and moves the staged state aside. A replaced path that is a symlink
  into the developer's own repository is never written through: the rename puts
  a regular file at the live path, the target stays byte-unchanged, the link's
  target is recorded, and a rollback puts the link itself back (the approval
  diff says "replaces the symlink -> <target> with a regular file"). A live file
  the developer changed after the staged copy was taken is **refused before
  anything is written**, and the conflict names the path. Any other failure — a
  write or the reload — restores every replaced file, removes every added one,
  and leaves the drafts in place for the retry.
- **Post-promotion smoke check.** After a promotion, `setup.smoke` resolves the
  **live** defaults of build, run and test through the same resolver every other
  consumer uses (the agent tools, `env_list` and the developer's Build action)
  and compares them with the defaults the gate validated, which the run recorded
  in its own snapshot. A live default that is not the validated one fails the
  check with the drift named and the rollback offer — the defect this exists for
  is a promotion that left the live Dockerfile target beside the promoted shell
  target, which the smoke check used to start without noticing. When they do
  match it starts the resolved run target and proves that every promoted file
  still holds the digest the gate recorded, so `build: skipped (proven identical
  by the gate: <target>)` is a checked statement that names what it did not
  rebuild. A
  failure offers the developer rollback (`rollback-promotion`, which restores
  exactly the previous files — content and mode — from the promotion's own
  backup and puts the staged root back for the author) or keeping the promotion
  with the failed check recorded. Neither runs before approval: the smoke step
  is only reachable from the promotion's success edge, which is only reachable
  from the approval edge. When the check passes the workflow's staged state is
  removed and the promotion backup is kept; a workflow that never reaches a
  successful smoke check has its staged state removed when it is closed (the
  `environment.setup-cleanup` effect the close behavior enqueues for this
  family). A stale staged root of a workflow the store no longer knows is
  removed by `sweepStaleSetupState`, which the server's startup sweep calls.

The workflow ends at `core.completed` with `close` only; closing releases the
app slots through the same owner-bound `environment.teardown` effect every
family uses.

## What the agent-facing tools report, and from where

The `env_*` tools are the surface a durable run acts through, and one rule
covers all of them: a signal is derived from the run record that actually holds
the app, never from a remembered flag (`fix-env-tool-defects-from-e2e`).

- **A start is only `running` once the run is alive AND the readiness its
  definition declares has passed.** The slot controller executes the readiness
  the app's own definition declares (`fix-env-tools-round-2`):
  - a **docker/compose** target waits for its containers: every container of the
    app's compose project must be running, a container that declares a
    `healthcheck` must be `healthy` (`starting` is not ready), and a definition
    with no healthcheck must have its **published ports accept connections** on
    `127.0.0.1`. A container that exits or turns `unhealthy` while the start
    waits fails it with the container's own last output lines.
  - a **script** target has no container, so the readiness it declares is its own
    header annotation `# devenv:ready=<http(s) url | host:port>`; the start waits
    for that endpoint to answer (under status 400 for a URL, a TCP connect for a
    `host:port`). A process that exits while the start waits fails it with kind
    `run-exited`, the exit status and the last lines of the run's own captured
    output, and the slot is released as `stopped`/`failed`.
  - a target that declares **nothing** gets the settle window
    (`environment.instances.run_settle_seconds`, still 2 s): the process (or the
    container) has to stay up that long, and nothing more is claimed.
  The wait is bounded by `environment.instances.readiness_timeout_seconds`
  (default 120 s, file-only, re-read per start). When the bound expires the run
  keeps the slot and the answer is `starting`, naming what it is waiting for and
  the last probe's own result (`waitingFor`, `lastProbe`); `env_status` reports
  the same `readiness` object, so a run that is up is never reported as serving
  by a later call.
- **One record answers every status read.** `EnvironmentInstanceController.runRecord`
  is the single derivation behind `env_status` (each app's `run`: runtime, state,
  exit code, pid, and a dead run's captured log path and last lines), `env_logs`
  and the app status API (`appRuntimeStatus` ranks the record as one more
  observation for shell runtimes), so a live run, a dead one and a replacement
  cannot be reported three different ways. A persisted `running` row whose run
  this server process never started (a row a previous process left behind) is
  reported `unknown`, never `running`: the slot still holds the app until a
  developer release or a stop clears it, and a read never claims a process is
  there when nothing can observe it.
- **The readiness probe is the definition's, and the answer names it.**
  `env_status` (each app's `readiness: { ready, waitingFor, lastProbe }`) and
  `env_start` (`outcome: starting` while it is not ready) report the same probe,
  so "the container is up" and "the application serves" are never the same
  answer.
- **A shell run has a log file.** The run's stdout and stderr go to
  `<config>/logs/instances/<app>.log`, so `env_logs` reads a shell app's own
  output; a docker/compose app reads its containers and a script service its
  declared log file. The run's output is also what a failed start and a dead
  run's status report.
- **A missing container runtime says what was probed.** The `docker` candidates
  include the per-user sockets a `docker` CLI resolves from its own context
  (Docker Desktop, colima, OrbStack, rootless), and a selection that fails
  reports the command, every endpoint it tried and that no daemon answered.
- **`env_list` is compact by default**, with `detail: "full"` (or an `app`
  filter) for the ids and the reasons, and carries an `infrastructure` section
  (ident, kind, ports, observed state, declared `db_query` connection).
  `env_status` accepts an infrastructure ident; `env_start`/`env_stop` refuse one
  and name the app whose requirement starts it when a live dependency lease
  names it.
- **An infrastructure service's state is a probe, not a guess**
  (`fix-env-tools-round-2`): the container runtime the composition attached is
  asked. `running`/`starting`/`stopped`/`failed` come from the container's own
  status; a service with **no container at all** is `not-created`; and `unknown`
  is reserved for the one case where no runtime could be asked (no container
  runtime was selected, or the daemon could not be read). Round 1 answered
  `unknown` for a service that had simply never been created, because the TUI's
  own server composition attached no container runtime to the agent environment
  routes at all.
- **`otel_query` ranks requests before poller traffic**, reports the count it
  ranked out, and evicts a poller's single-span trace from its live index before
  a request trace — insertion order alone let a backend that polls twice a
  second push the request trace out of the 200-trace window about a hundred
  seconds after it was listed. A span-tree lookup distinguishes the two ways a
  trace can be missing: `trace-evicted` (received, then dropped from the live
  index) and `trace-unknown` (no run of this workflow exported it). Its `http`
  filter matches the method, the route/target/URL attributes and the span name
  of any span of the trace, with or without a leading `METHOD `, and an answer
  with `matched: 0` carries `considered` plus how many traces each active filter
  rejected on its own, so the filter that removed the trace is named instead of
  the answer being a bare zero. Its logs mode answers the OTLP log records of
  the same runs by trace id — the receivers decode `/v1/logs` with the same
  `ac.owner` attribution the spans carry.
- **The browser tools need no configured service.** The server drives one
  locally launched Playwright browser (a system Chrome, or the Chromium installed
  under this configuration) rather than the `playwright-server` infrastructure,
  and a scripted session gets an allow-list facade that fails an unknown method
  with the list of supported ones.

## Hosted stages

A **stage** is a non-production environment an agent run may drive directly in a
headless browser: an integration or staging deployment of a real application,
whose URLs, login recipes and navigation rules an operator declares in one file.
It is the answer to "test this against a deployed app" without handing a model
a URL and a password and hoping. Nothing here applies to a production system:
a production-like name is refused by the catalog, and only the operator's own
`$AGENTIC_CODING_CONFIG_DIR/stages/definitions/*.json` files can define one
(`docs/config-inventory.md`).

- **The catalog is the boundary, and every rule it declares is enforced.**
  `allowedOrigins` is the origin allow-list, checked on main-frame document
  navigations only — a page may still load its own fonts, styles, scripts and
  (read-only) API calls from wherever it likes, but the *document* never lands
  on another origin, so an injected redirect cannot take a session off the
  stage. A request whose URL cannot be parsed is refused rather than assumed
  safe, and `about:`/`blob:`/`data:`/`javascript:` are allowed because they
  navigate nowhere. Where a real application genuinely needs one state-changing
  call (a search that POSTs, a filter), `readOnlyExceptions` names it by origin,
  path prefix and method; **everything else is read-only** — `GET`, `HEAD` and
  `OPTIONS` are safe, every other method is refused. A refusal aborts the
  navigation and comes back to the caller with its own code (`origin-not-allowed`
  or `stage-read-only`) and, beside it, the refused URL reduced to origin and
  path: no query, no fragment.
- **A refusal is reported on the next tool result.** Each stage-bound session
  keeps a bounded buffer of refusals (origin+path, method) that the next browser
  reply drains and attaches as `guardEvents`, whether that reply succeeded or
  failed. An agent therefore learns that a navigation was refused instead of
  seeing a bare `net::ERR_ABORTED`, and the operator learns the same from the
  session's own record.
- **Login is a declared recipe, executed server-side.** `stage_login` runs an
  ordered multi-page `form` recipe (a field step, an optional submit control, an
  optional prompt step — what an Entra ID login needs) or installs an
  `http-basic` credential on the browser context. The credential is resolved from
  the configuration `.env` at that moment, typed into the page, and never
  returned: the answer names the recipe, the role and which elements were
  filled, and a saved repro spec carries the credential *variable names* so a
  later run can re-enter them itself. A login that never finishes is bounded
  (`login-timeout`), a control that never appears is named (`login-step-not-found`),
  and a second factor the recipe cannot answer — push, SMS, number matching — is
  reported as `login-mfa-required` rather than guessed at. TOTP is supported when
  the role declares a `totp` reference: the code is derived from the shared
  secret (RFC 6238) at the moment it is typed, so the secret is the only stored
  value.
- **A role may speak OAuth 2.0 instead, and then the server holds the token.**
  `"login": "oauth2"` is a third recipe: the role names a `provider`
  (`oauth2.providers.<name>`: an https `tokenEndpoint`, a `clientId`
  ``${VAR}``, an optional `clientSecret` ``${VAR}``, `scope`, `audience` and
  `clientAuth`: `basic` — the default — or `body`), a `grant`
  (`client_credentials`, `refresh_token` or `authorization_code`), and
  optionally `bearerOrigins`. For the two unattended grants `stage_login` asks
  the provider for a token and answers `ok` with `via: "token"` once one
  exists — no login page, no window, no typing, no prompt — so an unattended
  policy (`interactiveLogin: "never"`) is the normal case for them: a
  `client_credentials` role, and a `refresh_token` role whose ``${VAR}`` refresh
  token the `.env` sets. A missing reference is the familiar
  `credential-missing` naming the variable, and a provider refusal is
  `login-failed` with the provider's own `error` code (its `error_description`,
  scrubbed and bounded, is the message) — never a token.
  `authorization_code` is the third grant: the user-delegated one, where the
  identity at the provider is the developer's own. It is a **hand-off**, so
  `stage_info` reports that role's `loginMode` as `handoff`, and `stage_login`
  answers `login-needs-user` — see the bullet on the code grant below.
- **The code grant is a person's sign-in on a single-use loopback receiver.**
  For a role whose grant is `authorization_code`, `stage_login` builds an RFC
  7636 PKCE pair (a 43-character verifier and its `S256` challenge) and an
  opaque, unguessable `state`, opens the provider's `authorizationEndpoint` in
  the *same* hand-off window the interactive login uses (one record, one window,
  one session lock, one deadline), and listens on
  `http://127.0.0.1:<ephemeral>/callback` for the redirect. The receiver is
  bound to the loopback interface only, accepts exactly **one** callback,
  compares `state` in constant time before anything else, and closes on every
  ending path — success, a mismatched `state`, the deadline, an abort — so no
  port stays bound after a login. The authorization code, the verifier and every
  token stay in the server: they are added to the redaction set while the login
  runs (the code and `state` stay registered after the login ends, so a replay
  of the callback URL is scrubbed too; the set keeps the newest 64 values in
  all, and a finished login leaves two of them — its `state` and the code its
  receiver took — so roughly the 32 most recent logins stay covered and the
  oldest value falls out, one per new value, to make room), the callback page
  reflects no
  parameter, and a `state` mismatch, a provider `error` or a refused exchange
  ends the login as `login-failed` with a value-free message. `stage_login_wait`
  answers `ok` (`via: "token"`, `verified: true`) **only** after the exchange
  succeeded and the token is in the store — an exchange whose write a
  credential rewrite discarded during the round trip is not an `ok`; a *Done*
  that never completed is
  `login-handoff-unverified` (the ending of a recipe a page can finish, which
  this grant never offers), a deadline is `login-handoff-timeout`, a closed
  window or an abort is `login-handoff-aborted`, and a sign-in the provider
  refuses is `login-handoff-unverified` or `login-failed`, never `ok`. This
  grant offers no *Done* to choose — neither in the window's banner nor in the
  dashboard record, whose only answer is *Abort* — because its ending is the
  server's own receiver and a *Done* could only close it unverified. The token
  is then an ordinary one: `stage_api_request` and a `bearerOrigins` page use
  it, the completed hand-off returns the window to the application (rather than
  leaving it on a callback page that no longer answers), and no path that merely
  *needs* a token starts a window. A token this grant obtained is renewed like
  any other **when the provider issued a refresh token**: the store renews it
  from that token, and a role whose provider issued none has nothing to renew —
  such a request is `login-failed` ("call stage_login") until the developer
  signs in again. `scope` and `audience` come from the provider, a provider
  with no `clientSecret` is a public client (no `Authorization` header is sent,
  the client id travels in the body), and a provider that returns a refresh
  token gets it stored like the `refresh_token` grant's. Registering the
  loopback redirect is the operator's job, and the shape to register is
  `http://127.0.0.1:<any port>/callback` — loopback, an ephemeral port, the
  path `/callback`, no query. An identity provider that forbids a loopback
  `redirect_uri` (or that pins an exact port) reports its own refusal *inside
  the window* — no redirect comes back, so no code is exchanged — and that is a
  registration decision rather than an engine fallback: the hand-off then ends
  at its deadline or by an abort. A policy of `interactiveLogin: "never"`
  refuses the login outright (`login-user-unavailable`, `loginMode:
  "unavailable"`) instead of opening a window, and that answer wins over the
  missing-variable one, which belongs to a stage that could hand off: under
  `never` naming a variable whose setting still could not open a window would
  send the developer to a dead end. Under `local`, a code role whose client id
  — or client secret, when the provider declares one — is not set in the `.env`
  answers `credential-missing` naming that variable (`loginMode:
  "unavailable"`), and a provider that declares no client id reference at all
  never reaches a login: its stage file is refused at load with a diagnostic
  naming `oauth2.providers.<name>.clientId`, because no `.env` value could fill
  it.
- **A token login still needs the session it runs on.** `stage_login` is a
  browser-layer action on an open, stage-bound session: an *unattended* token
  login opens no page, window or prompt, but it — and the `authorization_code`
  hand-off, which does open one — needs `browser_open({ stage, stageApp })`
  first, counts as one stage action and holds one session slot. A run that
  only needs an API needs no session at all: `stage_api_request` acquires and
  renews the token itself.
- **The token is the server's, and only its shape is ever reported.** The
  access token lives in an in-memory store keyed by `(stage, app, role,
  provider, scope set)`, is renewed single-flight when a caller arrives inside
  the skew window (a rotated refresh token replaces the old one), is forgotten
  when the role's credential is rewritten in Settings, and is bounded by an
  absolute lifetime and an entry cap so a long-lived
  process cannot grow it without limit. It is never written to a file, a store
  table, a log line, a journal entry, a tool result or an evidence file, and it
  never reaches the model: `stage_token_info` presents exactly `expiresAt`,
  `scopes`, `audience` and `issuer` (`expiresAt` is epoch **milliseconds**, so
  `expiresAt - Date.now()` is what is left of the token's life), and every reply
  passes the redactor over
  the live token values (and their URL-encoded forms) as well as over `.env`.
  `browser_network` says whether a request carried an `Authorization` header and
  shows `authorization: "«redacted»"` in place of its value.
- **`stage_api_request` is how a run calls an API application.** It sends the
  role's token to the application's configured origin and nowhere else: the tool
  takes a **path** (`/v1/requests?limit=5`) or its `query` object, never a URL,
  so the host cannot be
  redirected by the model; an `Authorization` header the agent supplies is
  refused (`stage-auth-header`) rather than overwritten; the stage's origin
  allow-list must contain the result; a `read-only` stage refuses any
  state-changing method and any declared exception that does not match; the
  body is bounded at 64 KiB (measured in bytes) and the response at 256 KiB
  (truncated, with `truncated: true` and no silent cut — and if the *tool's* own
  answer is cut, the cut happens inside the body so `truncated`, `bytes` and
  `renewals` still arrive); the call is bounded by a 20 s timeout
  and one renewal-and-retry on `401`; and only allow-listed response headers
  (`content-type`, `etag`, `location`, `retry-after`, …) are returned — never
  `set-cookie` or a hop-by-hop header. Calls count against the stage's
  `maxActionsPerMinute` like any other stage action, and a refusal that has a
  wait attached says so in the answer a model reads.
- **A bearer header is scoped to an exact origin, and to the stage's own pages.**
  `bearerOrigins` declares
  the origins a *browser session* also authenticates with the role's token. The
  header is added by the context's route handler, which asks the token store per
  request: the origin must match one the stage declares exactly, the request has
  to be issued by a document the stage itself owns (one of the stage's app or
  allow-listed origins — a frame from anywhere else, or a request that names no
  document at all, goes out bare), a request that
  already carries an `Authorization` header is left alone, a cross-origin
  redirect lands on an unmatched origin and therefore goes out bare, and a token
  that cannot be obtained leaves the request unauthenticated instead of aborting
  the page. Nothing about the header is readable — a page can neither read it
  back nor find it in a tool result.
- **A client-side token is the limit worth knowing.** The token is held for the
  session, not *inside* it: this design authenticates the server's own requests,
  so an application whose JavaScript performs the OAuth 2.0 flow itself (a
  browser SPA holding the token, calling its API from the page) cannot be driven
  this way. Such a stage keeps the interactive-application path — a `form`
  recipe and a hand-off, or a service account the application accepts — and the
  unattended seam is an `oauth2` role for the API it calls, which is what
  `stage_api_request` is for.
- **The session's own identity is not readable.** On a stage-bound session the
  script facade refuses `context.cookies`, `context.storageState`,
  `context.addCookies` and `context.clearCookies`
  (`stage-session-restricted`): a cookie is a credential by another name, and
  reading it out would defeat every rule above.
- **Redaction covers everything a browser replies.** Every browser reply (and
  every error) passes the shared redactor over the configuration `.env` values
  and their URL-encoded forms — a value an app echoed into its own page text, a
  console line, or a script's return value comes back as
  `«redacted:NAME»` — and then a URL sanitizer that drops a token-like query
  parameter (`code`, `token`, `sessionId`, …) and an opaque fragment from every
  URL-shaped string. A credential is therefore covered twice: by value and by
  the URL that carries it. The one browser operation redaction cannot cover is a
  **recording**: video is bytes, not text, so a credential fill is refused while
  a session is recording (`recording-active`), and the same refusal guards
  `stage_login`.
- **A flow test narrates itself in a journal, and the server owns the facts.**
  `stage_step({ session, label, expected?, observed?, captures?, evidence?,
  knowledge? })` appends one entry to the workflow's `stage-journal.jsonl` beside
  its evidence manifest. The sequence number, the time, the session, the session's
  stage application and role, the current URL and — while a recording runs — the
  segment and offset are all derived by the server; the agent supplies only its
  own text. Every written value passes the same redactor and URL sanitizer a
  browser reply does, before the bytes land, so a step's label or capture can
  never smuggle a credential into a file that outlives the call. An `evidence`
  id that the manifest does not hold is refused (`evidence-missing`, 404) with
  the journal untouched, and the file is capped at the evidence per-file limit
  (`stage-journal-full`, 409) rather than grown or silently truncated. Each line
  names its shape (`"v": 1`); a journal a newer build wrote is read-only to this
  one — the read, the step and the panel say so with the version — because the
  two operations that rewrite the file would drop every field they do not know.
  The cap holds for a rewrite too: back-filling a kept video grows the lines it
  touches, and a rewrite that would cross the cap is refused whole (the file is
  left exactly as it was, still readable) rather than landing a journal no reader
  can parse. The parsed journal is cached by the *file* — one workflow's journal,
  not the data root every workflow of a worktree shares — and only for an
  unchanged `(mtime, size)`, so two workflows of one checkout never read each
  other's steps.
  `stage_journal({ session?, app?, limit? })` reads the latest entries back,
  bounded, which is what a compacted run reads instead of its own history. A step
  is not an action *of the stage*: `stage_journal` charges no stage action, while
  `stage_step` is one browser call like any other.
- **A recording is a segment, and its steps are seekable.** Each
  `browser_record_start` answers a `segment` number the pool assigns per workflow,
  and every step written while it runs carries that segment and its
  `offsetMs` since the recording started. A stop with `keep: true` stores the
  video with the same `segment` and back-fills the video's evidence id onto the
  segment's steps, and a discarded recording takes the segment and offset back off
  them and re-renders the page: a step must never name a video nobody kept. The
  steps keep their sequence numbers, and a discard spends no budget. Kept video time is bounded per workflow and stage by the stage's
  `limits.maxRecordingMinutes`: a start is bounded by what is left of it and is
  refused with `stage-recording-limit` once the budget is spent — the refusal
  suggests `stage_step` without a recording, because a flow is documentation
  first and footage second. The grant is held *by the session that took it*, for
  `min(one segment's ceiling, what is left)` and only until that segment ends, so
  two sessions cannot be told the same remainder, a refusal can only release its
  own grant, and a segment that is stopped out of order, auto-stopped for
  outliving its bound, or lost with its session gives its minutes back rather
  than holding the budget until it expires. A start on a session that is already
  recording is refused as `recording-active` (409) — that is what it is — rather
  than by the budget its own live grant has spent. The swap into the recording context carries the
  cookies and `localStorage` it always did, and now also the live page's own
  origin's `sessionStorage` (read from the page before its context closes,
  installed as an origin-scoped init script), so an SPA that keeps its token
  there stays logged in. A stop carries that state back the same way — the
  recording's page is the one that owns the tab by then — so the flow continues
  in the context it started in.
- **`stage_wait` waits inside the server, so a wait costs one tool call.**
  `until` takes exactly one of `text`, `selector`, `url` (matched as a substring,
  or as a glob when it holds `*`) or `mail` (`{ to?, subject? }`, at least one).
  The server re-checks it every `intervalSeconds` — the floor is 5 s, whatever
  the caller asks for, because a flow is observed rather than hammered — re-opens
  the session's URL between polls when `reload: true`, and answers once with
  `met`, `timeout`, `elapsedMs` and the URL. `timeoutSeconds` is capped by the
  stage's `limits.maxWaitSeconds` (default 600 s), and the client's own bound sits
  just above that cap so the server's answer wins. A `mail` condition is valid
  only on the session of a stage application of `kind: "mail-catcher"` declaring
  `api: "mailpit"` (`stage-mail-unsupported` otherwise) and is checked through
  that application's own `GET /api/v1/search` with a `to:`/`subject:` query; a
  catcher that is not up yet is a condition that does not hold, not a failure. Each
  poll step is itself bounded, and the session is re-checked between polls: a page
  that never answers, or a session closed underneath the wait, ends it instead of
  holding past its own bound. The wait is one stage action for the rate limit.
- **A screenshot can be stored without being seen.** `browser_screenshot({
  evidence: true, view: false, caption })` stores the picture and answers its
  evidence id, caption and a notice instead of the image, so documenting a step
  costs no context. `view: false` without `evidence: true` is refused
  (`view-requires-evidence`): a screenshot that is neither shown nor stored is a
  call that did nothing. On a stage session, stored screenshots count against
  `limits.maxScreenshots` per workflow: a stored screenshot is *reserved* in one
  synchronous step before the capture, so a refused one
  (`stage-screenshot-limit`) takes no picture at all and two calls that overlap
  in their capture cannot both pass the same bound; a capture or an attach that
  fails gives its reservation back, so nothing is stored beyond the bound and the
  refusal only ever answers a call that stored nothing. Merely viewing a
  screenshot spends nothing either.
- **The flow page is the run's own report, and it needs nothing to open.**
  `stage-flow.html` is written beside the evidence from the journal and the
  manifest alone — segments in journal order, each with its kept video by
  *relative* file name, and each step a link to its own offset through a `#t=`
  media fragment — so it opens from a `file://` URL with no server, no network and
  no binary dependency, and the same journal and manifest always render the same
  bytes. It is regenerated whenever the journal or the manifest changes (a step,
  a kept recording, an attached file) and is written through the same redactor, so
  it can never show a value the journal does not already hold. The write happens
  inside the evidence root's lock, and the writer renders from the journal and
  manifest it has already parsed in that same section, so one step costs one
  parse of each file rather than two and no page can be written from a snapshot
  older than the step it shows. The whole artifact
  disappears with the workflow's evidence directory, which
  `workspace.cleanup` already removes.
- **A login the server cannot automate is handed to you, not failed.** A role
  whose credentials this `.env` does not set, or whose recipe declares
  `kind: "interactive"`, needs a person: `stage_login` answers
  `login-needs-user` with a `handoffId`, the reason (`no-credentials`,
  `unautomatable-step` or `user-identity` for the code grant's own sign-in) and
  the deadline, and the server opens a **second, headed browser** and *promotes*
  the session into it — same session name, same
  owner, same slot, same stage binding — so the developer logs in in the same
  context the run will keep using. The headless context is closed; the promoted
  one carries a banner naming the app, the role and the stage (never a URL with
  a query or a credential). `stage_login_wait` then blocks *in the server*, so
  no run is parked and no model turn is spent: each call executes one stage
  action and answers `login-needs-user` while the developer is still working, or
  the terminal outcome — `ok` (`via: "handoff"` for a page login, `"token"` for
  the code grant, with `verified`), or
  `login-handoff-unverified` / `-timeout` / `-aborted` (`by: developer | agent |
  window-closed | run-ended`), or `login-failed` when the provider itself
  refused the sign-in (the code grant's exchange). A terminal outcome is a
  `blocked` verdict with
  that code as its reason. A deadline **closes** the window and leaves the
  session unusable: the next `browser_open` for that name opens a fresh one
  (until then a call answers `browser-crashed`), because a login nobody finished
  is not a page the run may read. When the hand-off ends, the window is the
  agent's again — stop typing in it, since the run drives the same page from
  there — and the login outlives that session only through the identity cache
  below: nothing is written to the configuration directory, no profile or
  storage-state file is kept, and a stage whose cache is off, or has nothing for
  that role, starts its next session logged out. A conditional-access policy that rejects an
  unmanaged or non-compliant browser still refuses the login inside the window;
  that refusal is the tenant's, not this tool's, and the hand-off then ends as
  `login-handoff-unverified` or on its deadline. One hand-off is active per
  server and the rest queue
  FIFO (`queuePosition`), a held session is refused to every other browser tool
  (`session-held-by-user`), and a recording is refused outright
  (`recording-active`) so a credential never reaches a video. `http-basic`
  roles do **not** hand off: the browser's own authentication dialog does not
  appear in a window this server launched, so such a role keeps
  `credential-missing` (naming the variable) or `login-user-unavailable`, and
  the automated `http-basic` recipe when its variables are set. The
  developer-dialogue record
  (`kind: "login-handoff"`) is the *Done*/*Abort* surface: it is never routed to
  the orchestrator, never appears in a run's prior dialogue, and resolving it
  never resumes a blocked run.
- **A successful login leaves a bounded identity in this server's memory.**
  Signing in per role per run is the most expensive thing a stage test does, so
  the server keeps what the login established: for one `(stage, role)`, the
  browser state of the stage's own application and login origins — cookies
  (including the `HttpOnly` session cookie and the identity provider's
  `Domain=…` sign-on cookie) and those origins' `localStorage`/`sessionStorage`
  (where MSAL keeps its token cache). It lives **only in memory**: never a file,
  never the workflow store, never a log line, a telemetry attribute, a snapshot,
  an evidence file or a tool result, and a restart starts empty. A session that
  names the role — `browser_open({ stage, stageApp, stageRole })` — is created
  *with* that state already installed (the cookies before the first request, the
  storage as an origin-scoped init script, so an application that reads its
  token at load finds it), and `stage_login` then re-checks the recipe's declared
  success condition instead of trusting the cache: accepted answers `ok` with
  `identity: "cache"` and re-captures what the visit left behind, rejected evicts
  the entry and runs the ordinary login. A login result is the only place the
  source is reported: it carries `identity: "cache" | "recipe" | "user"` and
  nothing else about the state (a capture itself answers only whether it stored
  something). The listing and the dashboard show `(stage, role, capturedAt,
  expiresAt)` plus `truncated`, a *count* of the values the capture bounds
  dropped — a value kept is at least 6 characters (the redactor's own floor, so a
  stored value is always a scrubbed one) and at most 32 KiB, with at most 256
  values and 512 KiB per entry — and no name or value, and neither a capture, a
  refresh, a rejection nor a forget writes a log line about the state. The set
  those values join while a live context carries them is bounded the same way
  (`mergeIdentitySecrets`: newest 512 values / 1 MiB per context), so the scrubber
  cannot grow with the length of a run. The bounds are per capture — a
  default `identityCache.ttlMinutes` of 240 (ceiling 1440), `maxEntries` 8 per
  process (ceiling 50) evicting the oldest capture, expired cookies dropped on
  the way in, and a re-capture of a living session on the first browser call
  after `identityCache.refreshSeconds` (default 120, floor 30, ceiling 3600, and
  never longer than the TTL) — so a rotated
  refresh token, or a recording swap that dropped `sessionStorage`, reaches the
  cache while the run still works. The refresh is bound to use, not a timer:
  there is no background sweep, and a session nobody calls captures nothing more.
  `"identityCache": false` on a stage opts out entirely. Forgetting is available
  at all three granularities — one `(stage, role)`, every role of one stage, and
  everything — on each of the three surfaces: Settings → Stages (Enter on the
  entry; the stage row and the section's forget-all row remove every key in their
  scope, so they are armed by a first Enter and performed by a second),
  `agentic-coding stage identity forget [--stage S] [--role R] [--all]`, and
  `POST /api/v1/stages/identity/forget`, while
  `agentic-coding stage identity list` (or `GET /api/v1/stages/identity`) shows
  what is held. Forgetting never logs a live session out: it decides what the
  *next* one starts from, and a forget that a live session's own refresh or clean
  close would undo is held off until the next successful login. The `http-basic`
  recipe is **not** cacheable — the browser's own authentication dialog never
  shows this server the `Authorization` header it generates, and the change's
  spike confirmed the driver cannot observe it — so such a role installs its
  credential per session and caches nothing. A cached entry is never a credential
  this server acts on by itself either: it is browser state installed into a
  context that already answers to the stage's guard, and the declared success
  condition is what decides whether the login happened. Cached values join the
  redaction set (each value the store holds, the base64url segments of anything
  JWT-shaped, and their URL-encoded forms) — a value too short to be a credential
  is never captured, so a stored value is always a registered one — and so do the
  values a live browser context installed, for as long as it exists, so a state
  stays masked after its entry is forgotten or expires. A page that echoes one
  into its own text, console or a URL comes back masked. The OAuth 2.0 token
  store is a separate thing: it holds the token the *server* presents, while this
  cache holds what a *browser*
  keeps, and neither can be derived from the other. Rolling the server back is a
  config step as well as a code one: an older build reads an `identityCache` key
  in `stages/policy.json` or in a stage definition as an unexpected property,
  refuses the file, and (for the policy) then refuses every stage, so remove the
  keys before running the older build.
- **The hand-off is a policy seam, not an assumption.**
  `interactiveLogin: "local" | "never"` in `stages/policy.json` (default
  `local`); a stage may narrow it to `never` and can never widen it. Under
  `never` a login that needs a person is refused — `login-user-unavailable` for
  an `interactive` recipe, an `authorization_code` role or a role that declares
  no credential reference, and
  the recipe's own `credential-missing` when only a value is missing — and on a
  machine with no display or only a `headless_shell` build `stage_login` answers
  `login-handoff-unavailable` (`reason: "no-display"` or
  `"headless-only-browser"`) **before any launch is attempted**. `stage_info`
  and Settings → Stages report the same decision as `loginMode`
  (`automated` | `handoff` | `unavailable`) next to each role's
  `credentialStatus`, so an agent can plan for the hand-off instead of
  discovering it. The deadline is `limits.maxLoginHandoffSeconds` (default
  900 s, clamped by the policy's ceilings).
- **Limits are per stage, and a stage can be exclusive.** `limits.maxSessions`
  bounds how many sessions one workflow may hold on a stage at once (a second
  open is refused, not queued: `stage-session-limit`), and
  `limits.maxActionsPerMinute` bounds how many stage-bound tool calls one
  workflow may make per minute (`stage-rate-limit`, with `retryAfterMs`). A stage
  marked `exclusive` may be held by one workflow at a time
  (`stage-held`); the default is shared, because two agents reading the same
  integration environment usually do not conflict, and the residual risk of two
  runs in one shared shell session is accepted and stated here rather than
  half-solved. `stages/policy.json` `ceilings` clamps any definition downward,
  so an operator can bound a whole catalog without editing every file.
- **What an agent sees.** `stage_info` returns the catalog's structure,
  diagnostics and credential *presence* — never a value — and `browser_open`
  takes `stage` plus `stageApp` (and an optional `path`) to open a session bound
  to it. A raw URL inside a stage-bound session is checked against that stage's
  allow-list, so an agent cannot leave the stage by passing a URL, and it cannot
  re-bind a session to a different stage (`stage-mismatch`).

- **A developer opens a stage from the environment list, and that is not a
  session.** `o` on the Applications, Libraries or Infrastructure page reads the
  same allow-listed catalog (`GET /api/v1/stages`) and lists the configured
  stages with display name, ident, environment and access marker; an excluded
  file is absent rather than greyed out, and a failed read is the picker's own
  message. Choosing a stage hands one of its `kind: "ui"` applications to the
  platform's opener (`open`, `xdg-open`, `cmd /c start`) — the URL exactly as the
  stage declares it, with no token, no query parameter and no login recipe — so
  the browser is the developer's own. A stage with several UI applications
  offers them in a second step, the one whose `app` matches the highlighted row
  first. It is local and read-only: no stage session, no identity-cache entry,
  no `stage_*` tool and no server mutation is involved.

## One composition for both server roots

Two composition roots own a server: the headless `agentic-coding server`
(`src/server-command.ts`) and the TUI's own listener (`src/tui/index.tsx`). Both
build the environment stack through **one** function,
`createEnvironmentStack` (`src/server/environment-stack.ts`): the run
observation, the script lifecycle, the container/Kubernetes runtime routes and
the integration services the agent environment routes read (`env_logs`, an
infrastructure service's state, `env_build`/`env_test`, the slot controller).

This is stated as a rule because its violation was invisible: the TUI built the
integration services by hand and attached no container runtime, so
`env_logs grid-allocation-backend` and `env_logs mailpit` answered "the server
attached no container-runtime capability at all" while `env_start` of the same
docker app worked (the slot controller selects its own runtime). An
`EnvironmentInstanceController`'s own tests cannot see that: the capability the
routes read is a composition input, so it is asserted through the real
composition instead (`test/support/real-environment-server.ts`,
`test/env-tools-real-composition.test.ts`).

## Developer-facing behavior

- The TUI's run action checks the slot first: while an agent holds the app it
  refuses with one warning toast explaining that an agent run holds the app and
  naming the holding workflow, and the server refuses the same run request for
  any other client with the machine-readable `held-by <workflow>` error. The
  server applies the same refusal to an app's `restart` action, which would also
  replace another owner's copy.
- A developer `stop` of an app an agent holds is allowed — it is the developer's
  way to take the app back — but it yields the slot first, so the holder's next
  call reads `released-by-developer` and the queue may grant the next waiter
  instead of the row going stale behind a torn-down run. When the yield fails
  (for example the holder's own stop is in progress) the stop still runs and its
  response carries a `warning` field saying the holder was not notified.
- A stop or release of an app that has no holder still clears its
  `superseded` rows, so the documented upgrade remedy works even when the
  retired row is all that is left of the app.
- The container-runtime routes (`POST /api/docker/stop|restart`) are a low-level
  escape hatch: they act on a container id and do not consult the slot. A
  developer who wants the queue and the holder notice to stay consistent stops
  the app through its app-level action (or `POST /app/release`) instead.
- The server publishes `environment.slot.waiting` once per new queue entry
  (`{ app, waiter, holder, position }`), `environment.slot.granted` per grant
  (`{ app, owner }`), and `environment.slot.reaped` per app the idle lifecycle
  released (`{ app, owner }`). The shell turns them into toasts: "<waiter> waits
  for <app> (held by <holder>)", "<owner> got <app>", and "<app> sat idle, so it
  was released from <owner>". Resolving workflow ids to their sidebar titles is
  the same in all three. Only these bounded fields are published. A request may
  not name a `configOverlay`: the configuration root the server discovers and
  executes from is never chosen by a client.
- The Environments feature's **Slots** section lists every app that is
  agent-held or has waiters, from the same `environment.slot.*` envelopes over
  the domain stream plus a re-snapshot on a stream gap: holder, status,
  endpoints, idle time with the agent TTL remaining, and the waiting workflows
  in queue order with their wait time. `x` force releases the selected app after
  a confirmation that names the holder and the next waiter, and `Enter` opens
  the holder's (or a waiter's) workflow dashboard through the shell's sidebar
  resolution rule. The app list marks an agent-held app so a refused human start
  explains itself.

## Upgrading from the parallel era

The v9 migration retires the extra active rows of an app as `superseded` — it
never claims `stopped` from the database alone, because only observation can
know whether a parallel-era container is still there. On the next start,
`reconcile()` observes each retired row: one whose runtime is gone becomes
`stopped`, and one whose `<app>-<instance>` container is still running keeps its
`superseded` status and is logged. A retired row does not hold the slot, but its
container may still publish the app's static ports, so clear it before the next
start: a developer release or stop of that app stops the retired
`<app>-<instance>` project first (while the app is still held, so no granted
start can race it) and only then frees the slot. Containers are matched by the
retired row's own `com.docker.compose.project` label alone, because every run of
an app uses the same compose file. To see what is left:

```sh
docker ps --filter label=com.docker.compose.project
```
