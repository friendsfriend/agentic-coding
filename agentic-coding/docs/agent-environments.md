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

## API

| Route | Meaning |
| --- | --- |
| `POST /api/v1/environment/apps/acquire` | `{ owner, apps[], target?, profile?, waitSec? }`; answers `started`/`already-running` with the held instances, `waiting` with positions and holders, `released-by-developer`, or fails with `deadlock`. |
| `POST /api/v1/environment/apps/{app}/release` | Developer force release: stops the holder's run, leaves it the `released-by-developer` notice, and lets the queue grant the next waiter. |
| `POST /api/v1/environment/apps/{app}/stop` | Stops the app's current run without the notice. |
| `GET /api/v1/environment/apps/slots` | Every configured app's `holder`, `status` and `waiters`. |

`endpoints` report the definition's declared endpoint exports (Kubernetes
targets). A Compose target's ports are its own static mapping, so there is
nothing dynamic to report for them.

The holder's next call after a force release answers `released-by-developer`
once and then starts cleanly.

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
  (`{ app, waiter, holder, position }`) and `environment.slot.granted` per grant
  (`{ app, owner }`). The shell turns them into toasts: "<waiter> waits for
  <app> (held by <holder>)" and "<owner> got <app>", resolving workflow ids to
  their sidebar titles. Only these bounded fields are published. A request may
  not name a `configOverlay`: the configuration root the server discovers and
  executes from is never chosen by a client.

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
