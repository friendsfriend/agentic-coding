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
