# Spec Delta

## Purpose

Makes the JEV/System One classifier routing that selects per-step model pools
observable: every routing pass exports a bounded, content-free decision record
and a provider-call record into the same OTEL/JSONL telemetry stream that
already carries the agent sessions, so a workflow's routing behaviour can be
reviewed, tuned, and debugged the way its sessions can.

## ADDED Requirements

### Requirement: Every completed classification pass exports one decision record

The system SHALL export exactly one `routing.classified` event per completed
classifier routing pass on the engine telemetry layer. The event SHALL identify
the workflow, the routing step that issued the pass, the pass phase (`plan` or
`apply`), and the effect id, and SHALL report, for every step the pass asked:
the label the classifier selected, the reported confidence, whether that step
fell back to a pool's tagged default, and the model profile(s) pinned for the
step by that pass. A field the classifier or the pass did not produce SHALL be
omitted rather than reported as a placeholder, and the event SHALL report the
pass's fallbacks as a count so a silently defaulted pass is visible in one row.

#### Scenario: Single-selection pass records the applied profile

- **WHEN** a plan-phase pass asks `core.plan` and the classifier answers with the
  label `high-cost-smart` at a confidence at or above the selection floor
- **THEN** the `routing.classified` event SHALL report step `core.plan` with that
  label, that confidence, no fallback, and the model profile pinned for `core.plan`
- **AND** the event SHALL report the phase `plan` and the pass's effect id

#### Scenario: Below-floor confidence records a default fallback

- **WHEN** the classifier answers `core.plan` with a confidence below the
  selection floor
- **THEN** the `routing.classified` event SHALL mark `core.plan` as a fallback
- **AND** it SHALL report the pool's tagged default label and the profile that
  pass actually pinned, never the rejected answer's label as applied

#### Scenario: Roster pass records the selected planner set

- **WHEN** a pass asks a roster step and the classifier's probabilities select
  three distinct planner profiles
- **THEN** the `routing.classified` event SHALL report that step's selected count
  of 3 and the profiles pinned for the roster roles

#### Scenario: Answer-free pass still exports a record

- **WHEN** a step's answer collapses to a `noul` answer because the provider
  returned no usable decision for it
- **THEN** the `routing.classified` event SHALL still report that step and its
  applied profile and fallback flag
- **AND** it SHALL omit the label and confidence it never received

#### Scenario: Pass that never completed exports no decision record

- **WHEN** the classifier call fails, times out, or the pass is retried
- **THEN** no `routing.classified` event SHALL be exported for that attempt
- **AND** the failure SHALL remain observable through the pass's provider-call
  response event

### Requirement: Every classifier call exports a bounded provider-call record

The system SHALL export one `routing.request` event when a classifier call is
sent and one `routing.response` event when it returns, on the adapter telemetry
layer, and both SHALL identify the classifier model, the pass phase, the number
of steps asked, the total number of pool entries offered, the number of
collected artifacts, and the size in bytes of the bounded state sent. The
response event SHALL report the measured call duration, the HTTP status of a
completed call, and the status class of that status.

#### Scenario: Successful call reports latency and status

- **WHEN** a pass's System One call returns HTTP 200 with a parseable answer
- **THEN** the `routing.response` event SHALL report an `ok` outcome, the HTTP
  status 200, its status class, and the measured duration of the call

#### Scenario: Reported usage is exported when present

- **WHEN** the provider response reports token or cost usage
- **THEN** the `routing.response` event SHALL export those numbers as numeric
  fields
- **AND** WHEN the response reports no usage, the event SHALL omit the usage
  fields rather than report zero

#### Scenario: Failed call exports status or failure class without answers

- **WHEN** the classifier call fails with a transport error, a timeout, or a
  non-2xx status
- **THEN** the `routing.response` event SHALL be exported with an `error`
  outcome and the failure's bounded error class, plus the HTTP status when one
  was received
- **AND** it SHALL NOT carry any classifier answer, label, or confidence

### Requirement: Routing events join the workflow trace and are attributable

Every routing event SHALL carry the layer, workflow id, step id, effect id, and a
W3C traceparent, so that the request, response, and decision records of one pass
resolve to the same workflow trace as the engine, adapter, and runtime events of
that workflow, and the three records of a pass share one effect id so a pass can
be inspected without time correlation. An identity field that cannot be resolved
SHALL be omitted rather than exported as a placeholder.

#### Scenario: The three records of one pass correlate by effect id

- **WHEN** a single classification pass completes
- **THEN** its `routing.request`, `routing.response`, and `routing.classified`
  events SHALL carry the same effect id
- **AND** all three SHALL resolve to the one trace id of the workflow

#### Scenario: Routing events join the agent session events of the run

- **WHEN** a workflow's telemetry stream contains routing events and pi runtime
  session events
- **THEN** a trace consumer grouping by trace id SHALL see them as spans of one
  workflow trace

### Requirement: Routing telemetry is bounded, content-free, and redacted

Routing telemetry SHALL NOT export the workflow task text, collected artifact
content, pool entry criteria, classifier answer text, prompts, or model output;
it SHALL export only scalar counts, sizes, statuses, confidences, labels, and
profiles. Every exported string SHALL have known credential shapes redacted
before it is written, and SHALL be bounded by the shared telemetry attribute
limit. A value that is not a string, number, or boolean SHALL be omitted.

#### Scenario: No prompt or artifact content reaches the stream

- **WHEN** a pass classifies a change whose planning artifacts contain source
  code and prose
- **THEN** the exported routing events SHALL contain the artifact count and byte
  sizes only
- **AND** no substring of the task text, the artifact content, the pool criteria,
  or the provider's answer text SHALL appear in the exported rows

#### Scenario: Credential-shaped values are redacted

- **WHEN** a reported label, profile name, or error class contains a
  credential-shaped value
- **THEN** the exported value SHALL be redacted before it is written to the
  telemetry stream

### Requirement: Routing telemetry is observational only

Emitting routing telemetry SHALL NOT change the classification result, the pool
selection a pass applies, or any workflow transition. A failure to build, bound,
redact, write, or export a routing payload SHALL be swallowed, and the pass
SHALL still apply its routing and the workflow SHALL remain runnable. Routing
telemetry SHALL NOT read or mutate workflow state, retry or re-issue a
classifier call, or switch a model or profile.

#### Scenario: Telemetry failure leaves the pass untouched

- **WHEN** writing or exporting a routing event fails during a pass
- **THEN** the pass SHALL still apply its selections and tagged defaults
- **AND** the workflow SHALL continue without an attention entry naming
  telemetry

#### Scenario: Telemetry never re-issues a call

- **WHEN** a pass's telemetry is emitted
- **THEN** no additional classifier call SHALL be made on the pass's behalf
