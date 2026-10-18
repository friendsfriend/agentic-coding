## MODIFIED Requirements

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
