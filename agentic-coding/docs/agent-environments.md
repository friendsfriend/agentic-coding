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
  bounded log tail, the default target per action is named, and two candidates
  for one default-profile build/test target are an explicit `no-default-target`
  finding rather than a silent pick. A step the machine cannot run (no docker
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
  (promote) or request changes with comments (back to the author).
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
- **Post-promotion smoke check.** After a promotion, `setup.smoke` starts the
  real default target once against the live configuration; it first proves that
  every promoted file still holds the digest the gate recorded, so
  `build: skipped (proven identical by the gate)` is a checked statement. A
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
