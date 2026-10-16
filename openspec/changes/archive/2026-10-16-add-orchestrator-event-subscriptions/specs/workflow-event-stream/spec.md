# Spec Delta

## ADDED Requirements

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
(`compaction`), gates (`gate.decided`), the orchestrator launch ceiling
(`limit.hit`) and OpenSpec progress (`openspec.task-progress`).

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

The launch-ceiling refusal SHALL emit `limit.hit` with the limit name, the
current count and the maximum, from the server path that refuses the start (the
one event not derived from a projection). A tracked workflow that is `active`
and has made no progress for longer than the configured
`[agents.orchestrator] stall_minutes` (default 30) SHALL emit `run.stalled`
naming the step and the elapsed minutes, and SHALL NOT emit a second
`run.stalled` for the same unchanged workflow.

#### Scenario: Orchestrator launch ceiling reached

- **WHEN** the server refuses an orchestrator start because `max_active` is
  reached
- **THEN** a `limit.hit` event SHALL be recorded with the current count and the
  maximum

#### Scenario: A stalled run

- **WHEN** a tracked `active` workflow has not changed for longer than the
  configured stall threshold
- **THEN** one `run.stalled` event SHALL be recorded for it

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
workflow of a repository except when rebuilding a baseline after a stream gap,
and SHALL derive nothing at all when `[agents.orchestrator] monitor` is `off`.
An unreadable workflow SHALL keep its previous projection and SHALL NOT emit an
event.

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
