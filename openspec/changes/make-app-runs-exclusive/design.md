# Design

## Context

Shipped by `add-environment-instances` (see `docs/agent-environments.md`):
`EnvironmentInstanceController` in `src/server/runtime/instances.ts`
(start/stop/list/get/reconcile), state v8 tables `env_instances` and
`port_allocations`, routes under `/api/v1/environment/instances`, owner
checkout resolution, and the reserved `config_overlay`. Human runs still go
through the action engine (`/api/apps/...` run actions); they do not create
instance rows.

## Goals / Non-Goals

**Goals:** static routing and ports; no agent ever starts a second copy of an
app; a waiting agent burns no tokens; the developer sees who waits for what.

**Non-Goals:** parallel copies, DB data reset on handover (data is kept as it
is), priorities or preemption between agents.

## Decisions

- **Slot = app.** `env_instances` keeps one active row per app (unique partial
  index on `app` where status ≠ `stopped`). The owner column says who holds it.
  Same-owner starts return `already-running`. A start by the same owner from a
  different checkout path is impossible: one workflow has one checkout.
- **Occupancy includes human runs.** The slot is occupied if an active row
  exists **or** run observation (`run-observation.ts`) reports a run target of
  the app running. An observed run without a row is reported with holder
  `user`. Unobservable state counts as occupied (observation failure is not
  absence).
- **Queue.** In memory, per app, ordered by one global sequence. A multi-app
  request is one entry placed in each app's queue. It is granted when every app
  is free and the entry heads every queue; global ordering makes this
  starvation- and cycle-free among waiters. In-memory is enough: waiters are
  live long-polls, and after a server restart the tool simply re-requests.
- **Long-poll contract.** `POST /api/v1/environment/apps/acquire
  {owner, apps[], target?, profile?, waitSec ≤ 300}` returns
  `started|already-running` with endpoints, or `waiting {position per app,
  holders}` when `waitSec` elapses. The next call by the same owner for the
  same apps keeps the queue position if it arrives within 60 s; after that the
  entry expires. Abort of the HTTP request withdraws the entry after the 60 s
  grace.
- **Deadlock.** Before enqueueing, build the wait-for graph (owner → holders of
  the requested apps → apps those holders wait for → …). If the requester is
  reachable, fail with `deadlock` and the cycle. `user` never waits, so it
  never closes a cycle.
- **Activity while waiting.** A waiting owner's held slots count as active, so
  idle TTL (`add-environment-instance-lifecycle`) does not reap apps the owner
  still needs.
- **Human start while agent holds.** The TUI run action calls a slot check
  first. If an agent holds the app, the action is refused with
  `held-by <workflow>` and a toast; the Environments view
  (`show-environment-instances`) offers force release.
- **Force release.** Stops the holder's run through the normal stop path,
  marks the row `released-by-developer`, and then grants. The holder's next
  call on that app returns `released-by-developer`.
- **Notifications.** The server publishes `environment.slot.waiting
  {app, waiter, holder, position}` once per new queue entry, and
  `environment.slot.granted {app, owner}`. The shell subscribes and calls
  `notify(..., "warning")` / `notify(..., "info")`, resolving workflow ids to
  titles through the sidebar model. Only bounded fields reach telemetry.
- **Static execution.** Compose runs with the file's own project name. Scripts
  get `AC_OWNER` and `AC_APP_DIR`. Image tags are whatever the definition says.
  Build actions run against the holder's checkout.
- **Migration v9.** Drop `port_allocations`. If several active rows exist for
  one app (left from the parallel era), keep the observed-running one and mark
  the others `stopped` after observation confirms they are gone. Otherwise keep
  them as `unknown`, which blocks the slot until reconcile or force release.
  Backup and integrity checks follow the existing path.
- **Routes.** `/api/v1/environment/apps/{acquire,{app}/release,{app}/stop}`
  plus `GET /api/v1/environment/apps/slots` (holder, status, waiters). The
  instance routes from v8 are removed. They have no external consumer yet:
  agent tools are not shipped.

## Risks / Trade-offs

- [A human run blocks agents indefinitely] → wanted. The toast tells the
  developer who waits.
- [Branch handover runs migrations of branch B on data of branch A] →
  accepted (data kept as-is). Agents can reset data themselves through the
  app's own tooling.
- [Long blocking calls] → bounded per poll, and the tool layer re-polls; the
  queue position is kept across polls.
