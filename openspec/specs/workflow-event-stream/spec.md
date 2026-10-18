# workflow-event-stream Specification

## Purpose
TBD - created by archiving change add-orchestrator-event-subscriptions. Update Purpose after archive.
## Requirements
### Requirement: Versioned workflow event catalog

The system SHALL define one versioned, typed catalog of workflow events in the
contract layer (`src/contracts/workflow-events.ts`), identified by
`WORKFLOW_EVENT_CATALOG_VERSION` and by stable event ids. Every catalog entry
SHALL declare its category, whether it is human-needed, and its bounded payload
shape. The catalog SHALL cover workflow lifecycle (`workflow.started`,
`workflow.completed`, `workflow.closed`, `workflow.failed`), attention
(`attention.raised`, `attention.cleared`), steps (`step.entered`,
`step.completed`), developer reviews (`review.waiting`, `review.resolved`),
developer questions (`question.pending`, `question.routed`, `question.answered`),
effects (`effect.failed`), delivery (`delivery.push`, `pull-request.state`),
runs (`run.started`, `run.completed`, `run.blocked`, `run.aborted`,
`run.stalled`), verification (`verification.finished`), compaction
(`compaction`), gates (`gate.decided`), the bus's own rate limit
(`events.suppressed`) and OpenSpec progress (`openspec.task-progress`).

#### Scenario: Every catalog event has a payload schema and a derivation test

- **WHEN** the catalog module is inspected
- **THEN** every event id SHALL declare a category, a human-needed flag and a
  payload schema, and each id SHALL be covered by a derivation test

#### Scenario: Human-needed set is the developer's decision set

- **WHEN** the catalog's human-needed events are read
- **THEN** they SHALL be exactly `review.waiting` and `question.pending`

### Requirement: Events derived from existing workflow state

Every event SHALL be derived from the durable workflow events and projections the
system already has — the workflow view of one workflow read after its
`workflow.updated` event — and SHALL NOT introduce a second source of truth. The
first observation of a workflow SHALL only establish its baseline and SHALL NOT
emit an event. An obligation that clears and returns SHALL produce a new event.
The events of one observation SHALL be ordered by the catalog's category order.

#### Scenario: First observation is silent

- **WHEN** a workflow already waiting at plan approval is observed for the first
  time
- **THEN** no event SHALL be emitted for it

#### Scenario: Step, review and question edges

- **WHEN** a workflow moves from implementation into developer review, acquires a
  pending developer question, then completes
- **THEN** `step.entered`, `step.completed`, `review.waiting`,
  `question.pending` and `workflow.completed` SHALL each be emitted once, in
  catalog order

#### Scenario: A failed effect and the attention edge

- **WHEN** a workflow's effect becomes `failed` and its status becomes
  `attention-required`
- **THEN** `effect.failed` and `workflow.failed` SHALL be emitted, and
  `attention.raised` SHALL NOT also be emitted for that same edge

#### Scenario: A cleared obligation returns

- **WHEN** a pending developer question is answered and a new question is
  acquired later
- **THEN** `question.answered` SHALL be emitted once and `question.pending`
  SHALL be emitted again for the new question

#### Scenario: Bounded, secret-free payloads

- **WHEN** any event is emitted
- **THEN** its payload SHALL carry only bounded summaries, SHALL contain no
  credential or raw transcript, and SHALL be masked by the contract redaction
  helper

### Requirement: Workflow-start events from the repository listing

`workflow.started` SHALL be derived from the repository listing: the first
listing of a repository SHALL establish its baseline without emitting a start
event, and a workflow id that appears in a later listing of an already-baselined
repository SHALL emit exactly one `workflow.started`.

#### Scenario: Baseline listing is silent

- **WHEN** the server first lists a repository whose store already holds five
  workflows
- **THEN** no `workflow.started` event SHALL be emitted

#### Scenario: A new workflow appears

- **WHEN** a listing of a baselined repository contains a workflow id the
  previous listing did not
- **THEN** exactly one `workflow.started` event SHALL be emitted for it

### Requirement: Refusal and stall events

A tracked workflow that is `active` SHALL emit `run.stalled` once it has made no
progress for longer than the configured `[agents.orchestrator] stall_minutes`
(default 30), naming the step and the elapsed minutes, and only after a fresh
read of that workflow confirms it is still `active` and unchanged: a workflow
that completed, closed or blocked since the last observation SHALL update its
projection instead (its transition is what is reported) and SHALL NOT produce
`run.stalled`. `run.stalled` SHALL NOT be emitted twice for the same unchanged
workflow.

#### Scenario: A stalled run

- **WHEN** a tracked `active` workflow has not changed for longer than the
  configured stall threshold and a fresh read confirms it is unchanged
- **THEN** one `run.stalled` event SHALL be recorded for it

#### Scenario: A finished workflow never stalls

- **WHEN** a workflow completed, closed or blocked without any event reaching
  the server, and its projection is still `active` when the stall threshold
  passes
- **THEN** the fresh read SHALL update the projection and record that
  transition, and NO `run.stalled` SHALL be recorded for it

#### Scenario: An unreadable workflow confirms nothing

- **WHEN** a workflow whose projection is still `active` cannot be read when the
  stall threshold passes
- **THEN** no `run.stalled` SHALL be recorded for it

### Requirement: One observation, one transition

The derivation SHALL be idempotent: the projection a derivation came from SHALL be
stored before anything the derivation publishes can be observed, a nested
observation of the same workflow SHALL be skipped, and the same event (id,
workflow id and payload) SHALL NOT be recorded twice while that projection state
is unchanged. Exactly one event SHALL therefore be recorded per real transition,
whichever path observes it - a `workflow.updated` naming the workflow, a
repository-level re-list, the reconciliation pass or a listing.

#### Scenario: A transition during a long effect

- **WHEN** a workflow enters a long, non-agent effect after an agent run
  completed, and the effect keeps committing progress (a repository-level
  `workflow.updated` per commit) while nothing about the workflow changes
- **THEN** the transition SHALL be recorded exactly once and no further event
  SHALL be recorded until the workflow really changes again

#### Scenario: The same transition observed by another path

- **WHEN** a transition was reported from a `workflow.updated` and the same
  unchanged projection is then observed by a repository refresh, the
  reconciliation pass and a listing
- **THEN** no further event SHALL be recorded for it

#### Scenario: A start reported while the listing is re-entered

- **WHEN** recording a `workflow.started` causes the repository to be listed
  again before that listing remembered the new workflow id
- **THEN** exactly one `workflow.started` SHALL be recorded for it

### Requirement: Bounded events per workflow

The server SHALL bound the events it records for one workflow: more than
`[agents.orchestrator] event_burst_limit` (default 120) of that workflow's
events inside `[agents.orchestrator] event_burst_window_seconds` (default 10)
SHALL be dropped, and the window's drop count SHALL be reported once as
`events.suppressed` with a bounded payload (`count`, `workflowId`, `windowMs`).
A human-needed event (`review.waiting`, `question.pending`) SHALL never be
dropped: the developer's own notification is not subject to the limit.

#### Scenario: A storm is rate-limited

- **WHEN** one workflow produces far more events than its budget inside one
  window
- **THEN** the events inside the budget SHALL be recorded, the rest SHALL be
  dropped, and exactly one `events.suppressed` SHALL report how many were
  dropped in that window

#### Scenario: A waiting review is never dropped

- **WHEN** a workflow's budget for the window is already spent and a review
  starts waiting or a developer question becomes pending
- **THEN** that human-needed event SHALL still be recorded

### Requirement: Bounded, cursor-addressed event log

The server SHALL keep the recorded events in a bounded, in-memory log addressed
by a monotonic sequence, and SHALL serve it on the authenticated `/api/v1`
surface with a cursor, filter fields and a bounded page size. A cursor older
than the retained window SHALL be answered as `cursor-expired` naming the oldest
retained sequence, never as a silent gap.

#### Scenario: Reading a page since a cursor

- **WHEN** a client reads events after a cursor with a filter and a page bound
- **THEN** the server SHALL return at most the page bound of matching events
  with the cursor to resume from

#### Scenario: Stale cursor

- **WHEN** a client reads from a cursor that predates the retained window
- **THEN** the server SHALL answer `cursor-expired` with the oldest retained
  sequence

#### Scenario: The log is bounded

- **WHEN** more events are recorded than the log capacity
- **THEN** the oldest events SHALL be evicted and the sequence SHALL NOT restart

### Requirement: Bounded derivation cost

The server SHALL derive events only for the workflow an event names, SHALL
debounce repeated events per workflow into one read, SHALL NOT read every
workflow of a repository except when a repository-level observation is
answered (a stream gap, a runId-less `workflow.updated`, the reconciliation
tick) and SHALL derive nothing at all when `[agents.orchestrator] monitor` is
`off`. An unreadable workflow SHALL keep its previous projection and SHALL NOT
emit an event.

#### Scenario: A burst of updates is one read

- **WHEN** eight `workflow.updated` events name the same workflow inside one
  debounce window
- **THEN** the server SHALL read that workflow once

#### Scenario: Monitor off derives nothing

- **WHEN** `monitor` is `off`
- **THEN** no workflow SHALL be read for event derivation and no event SHALL be
  recorded

#### Scenario: An unreadable workflow invents nothing

- **WHEN** a workflow's view cannot be read
- **THEN** no event SHALL be emitted for it and its previous projection SHALL be
  kept

### Requirement: Repository-level derivation

The server SHALL NOT drop a `workflow.updated` naming only a repository (the
refresh hub publishes one per committed effect of a drain, without a workflow
id): it SHALL coalesce into at most one re-list of that repository per debounce
window, bounded to a fixed number of pending repositories and released when the
bus stops. The listing SHALL report a `workflow.started` for an id a
baselined repository did not hold before, SHALL observe every listed workflow
the bus already holds a projection for exactly as a `workflow.updated` would
(so a completion, a raised attention, a waiting review or a pending question no
workflow-id-carrying event named is still derived), SHALL drop the projection of
an id the listing no longer holds, and SHALL NOT emit a start or a transition
for the first listing of a repository.

#### Scenario: A completion nothing named

- **WHEN** a workflow's run completes and the workflow completes in the store,
  and only a runId-less `workflow.updated` for its repository arrives
- **THEN** `run.completed` and `workflow.completed` SHALL be recorded for it

#### Scenario: A burst of repository events

- **WHEN** a drain publishes eight runId-less `workflow.updated` events for one
  repository inside one debounce window
- **THEN** the server SHALL list that repository once

#### Scenario: A repository re-list never nests

- **WHEN** something asks for a repository listing while a listing of that
  repository is still running (an event recorded during it, a consumer reading
  back into the bus)
- **THEN** the running listing SHALL complete undisturbed and at most one
  follow-up listing SHALL be coalesced for what asked, so the refresh costs one
  store read per window rather than a stack of them

#### Scenario: The bus's own queue filling up is not a refresh

- **WHEN** the server has published more events than the broker's per-subscriber
  replay capacity, so the bus's own subscription queue is full
- **THEN** a later publish SHALL NOT by itself re-list any repository (the bus
  consumes the stream live; only a named workflow, a repository-level event or
  the reconciliation pass reads the store)

#### Scenario: The first listing of a repository is silent

- **WHEN** the bus lists a repository for the first time
- **THEN** no `workflow.started` and no transition SHALL be emitted for the
  workflows it holds; only their baseline SHALL be recorded

### Requirement: Reconciliation of unobserved changes

The server SHALL re-list, at most once per
`[agents.orchestrator] reconcile_seconds` (default 30), only the repositories it
tracks that still hold an `active` or `attention-required` workflow in its
projection, so a change committed without any event in this process (a handoff
in another process, the CLI, a second TUI) is reported within about one
interval. A repository with no such workflow, a bus that has observed nothing,
and `monitor` = `off` SHALL each cost no store read at all.

#### Scenario: A change without an event

- **WHEN** a tracked workflow's view changes in the store and nothing is
  published
- **THEN** the next reconciliation pass SHALL read it and record its transition

#### Scenario: A change committed by another process

- **WHEN** a handoff in another process advances a tracked workflow and no
  event reaches this server
- **THEN** the reconciliation pass SHALL re-list that repository and report the
  change

#### Scenario: An idle bus

- **WHEN** every workflow the bus tracks is `completed` or `closed`
- **THEN** the reconciliation pass SHALL read no workflow

#### Scenario: Monitor off

- **WHEN** `monitor` is `off`
- **THEN** the reconciliation pass SHALL read no workflow

