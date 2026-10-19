## ADDED Requirements

### Requirement: Every operator repair records its cause and its effect

The system SHALL record an `operator.repair` with the transition it performs: the
reason the operator gave, bounded to 160 characters with control characters
collapsed and known credential shapes redacted by the same helper that bounds an
event's `detail`; the ids of the effects the repair expired, capped at 32 entries
and deduplicated; the ids of the runs the repair retired, capped the same way and
including a debug run the expiry launched; and the workflow's repair count at that
point, this repair included, read from the committed `operator.repair` events
rather than from a stored counter. The same record SHALL be readable on
`snapshot.repaired` and on the workflow view's `repaired`, so a reader of the
snapshot or the view sees why the workflow moved without reading the event log.
Every field SHALL be optional and additive: a repair with no reason SHALL still
repair, and a snapshot written before this record SHALL stay readable. Recording
SHALL NOT change the repair itself — not the source step, the target step, the
effects it expires, the runs it retires, or the outbox rows it writes.

#### Scenario: A repair names what it retired

- **WHEN** an operator repairs a workflow whose current step holds two open
  effects and one pending run
- **THEN** the `operator.repair` event data SHALL report both effect ids, the
  retired run id, the bounded reason, and the workflow's repair count
- **AND** the snapshot's `repaired` SHALL carry the same record, and the workflow
  view SHALL expose it

#### Scenario: A repair with no reason still repairs

- **WHEN** an operator repairs a workflow without giving a reason
- **THEN** the repair SHALL perform the same transition, expire the same effects
  and retire the same runs
- **AND** the record SHALL report an empty reason and the effect and run ids it
  retired

#### Scenario: The repair count spans the workflow's history

- **WHEN** a workflow that has been repaired twice is repaired a third time
- **THEN** the event's repair count SHALL be 3
- **AND** the count SHALL come from the committed events, so a store that lost
  nothing reports the same number the events do

#### Scenario: A long or secret-bearing reason is bounded

- **WHEN** an operator repairs a workflow with a reason longer than the bound or
  one that contains a credential shape
- **THEN** the recorded reason SHALL be truncated to the bound and SHALL have the
  credential redacted
- **AND** the transition SHALL be the one the operator asked for

### Requirement: Engine telemetry reports the repair without its id lists

The system SHALL export the repair as one engine telemetry event carrying the
bounded reason, the number of effects it expired, the number of runs it retired,
and the repair count, alongside the source and target steps. The telemetry payload
SHALL NOT carry the effect or run id lists: the durable event and the snapshot are
where those ids live. A payload field the engine does not hold at that boundary
SHALL be omitted rather than reported as a placeholder, and an empty reason SHALL
be omitted.

#### Scenario: The telemetry counts what the record lists

- **WHEN** a repair expires three effects and retires two runs
- **THEN** the telemetry event SHALL report an effect count of 3 and a run count
  of 2
- **AND** it SHALL NOT contain any of the expired effect ids or retired run ids

#### Scenario: A repair with no reason exports no reason field

- **WHEN** a repair is performed without a reason
- **THEN** the telemetry event SHALL omit the reason field rather than report an
  empty string
