## ADDED Requirements

### Requirement: Engine event identity

Every event the workflow engine exports to telemetry SHALL carry the workflow id, the step id at commit time, the committed revision, and the resulting workflow status. When the committed command or effect resolves to a specific run or effect, the event SHALL additionally carry that run's role, run id, attempt, resolved profile, runtime id, and the runtime session id when the run handle exposes one.

#### Scenario: Handoff event resolves to a run

- **WHEN** the engine commits an `agent.handoff` command for a run whose handle exposes a runtime session id
- **THEN** the exported event SHALL contain the run id, role, attempt, profile, runtime, and runtime session id
- **AND** the event SHALL contain the workflow id, step id, revision, and status

#### Scenario: Effect event resolves to an effect

- **WHEN** the engine commits an `effect.result` command for a known effect
- **THEN** the exported event SHALL contain the effect id and the effect kind
- **AND** it SHALL NOT fabricate a run id or role for an effect that has no run

#### Scenario: Engine event has no resolvable run or effect

- **WHEN** the engine commits an operator or developer command that resolves to no run and no effect
- **THEN** the exported event SHALL still contain workflow id, step id, revision, and status
- **AND** run, role, profile, runtime, and session fields SHALL be omitted rather than inferred

### Requirement: Engine event payload fields

Engine events SHALL carry a bounded, analysis-oriented payload of numeric or short scalar fields, taken from the committed event data, the workflow snapshot, and the affected run or effect row, without adding content text. Token, cost, count, attempt, round, byte-size, and duration values SHALL be exported as numbers, and envelope `outcome` and `durationMs` SHALL be used for the status and span duration of the event rather than being duplicated as attributes.

#### Scenario: Handoff carries outcome and run wall clock

- **WHEN** a run hands off with outcome `complete`, `blocked`, or `failed`
- **THEN** the exported event SHALL report that outcome and a duration in milliseconds covering the run's creation to completion
- **AND** it SHALL report the run attempt, the artifact digest, the artifact byte size, and finding counts by severity

#### Scenario: Effect result carries attempt and retry classification

- **WHEN** an effect reports `complete`, `retry`, or `failed`
- **THEN** the exported event SHALL report the effect kind, the attempt number, the maximum attempts, and the effect duration
- **AND** a non-complete outcome SHALL report a bounded error class instead of raw error text

#### Scenario: Question round-trip carries wait time

- **WHEN** a developer question or peer question is answered or expires
- **THEN** the exported event SHALL report the question or question-group identity, the asking role, the answering side, the answer kind (option or custom), the option count, and the wait duration in milliseconds

#### Scenario: Developer action carries the transition it caused

- **WHEN** a developer action is committed
- **THEN** the exported event SHALL report a normalized action id, the step before and after the action, and the revision that carried it
- **AND** a parameterized action such as an effect retry SHALL report its action category without the variable identifier

#### Scenario: Oversized or missing field values

- **WHEN** a payload field would exceed the bounded attribute length or is absent from the event data
- **THEN** the exported value SHALL be truncated or omitted
- **AND** the event SHALL still be exported with its remaining fields

### Requirement: Complete engine event export

Every durable workflow event type the engine commits SHALL also be exported to telemetry, including the effect-exhaustion event written when a leased effect exceeds its maximum attempts and the legacy-migration event written when a pre-existing workflow record is migrated.

#### Scenario: Effect exhausts its attempts

- **WHEN** the engine fails a leased effect after its maximum attempts and writes the effect-exhaustion event
- **THEN** a corresponding telemetry event SHALL be exported with the effect kind, attempt count, error class, and the workflow attention count

#### Scenario: Legacy workflow record is migrated

- **WHEN** `workflow migrate` converts a legacy record into a workflow instance
- **THEN** a corresponding telemetry event SHALL be exported with the source version, the phase, and the workflow type

### Requirement: Per-workflow effectiveness roll-up

The engine SHALL export a workflow-closing telemetry event carrying the numeric totals needed to judge a whole workflow without re-reading its event history, including verification rounds, revision count, run count, distinct agent count, developer-question count, and accumulated attempts per effect kind where the snapshot tracks them.

#### Scenario: Workflow reaches a terminal status

- **WHEN** a workflow commits the transition that makes its status `completed` or `closed`
- **THEN** the engine SHALL export one roll-up event for that workflow
- **AND** the roll-up SHALL include verification rounds, revision count, run count, distinct agent count, and the developer-question count

#### Scenario: Workflow ends with attention required

- **WHEN** a workflow stops in `attention-required` rather than reaching closure
- **THEN** the roll-up SHALL include the attention diagnostic count and the current step
- **AND** the roll-up SHALL be exported exactly once for that terminal transition
