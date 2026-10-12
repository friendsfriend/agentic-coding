## MODIFIED Requirements

### Requirement: Every classifier call exports a bounded provider-call record

The system SHALL export one classifier request event when a classifier call is sent and one response event when it returns, on the adapter telemetry layer, and both SHALL identify the classifier integration, the classifier model, the number of questions the call asked, the number of collected artifacts, and the size in bytes of the bounded state sent. The response event SHALL report the measured call duration, the HTTP status of a completed call, and the status class of that status. The events SHALL NOT describe a routing pass: no phase, no pool-entry count, and no selected pool entry SHALL be reported.

#### Scenario: Successful call reports latency and status

- **WHEN** a classifier call returns HTTP 200 with a parseable answer
- **THEN** its response event SHALL report an `ok` outcome, the HTTP status 200, its status class, and the measured duration of the call

#### Scenario: Reported usage is exported when present

- **WHEN** the provider response reports token or cost usage
- **THEN** the response event SHALL export those numbers as numeric fields
- **AND** WHEN the response reports no usage, the event SHALL omit the usage fields rather than report zero

#### Scenario: Failed call exports status or failure class without answers

- **WHEN** the classifier call fails with a transport error, a timeout, or a non-2xx status
- **THEN** the response event SHALL be exported with an `error` outcome and the failure's bounded error class, plus the HTTP status when one was received
- **AND** it SHALL NOT carry any classifier answer, choice, or confidence

### Requirement: Routing events join the workflow trace and are attributable

Every classifier call event SHALL carry the layer, workflow id, step id, effect id, and a W3C traceparent, so that the request, response, and decision records of one call resolve to the same workflow trace as the engine, adapter, and runtime events of that workflow, and the request and response records share one effect id so a call can be inspected without time correlation. An identity field that cannot be resolved SHALL be omitted rather than exported as a placeholder.

#### Scenario: The records of one call correlate by effect id

- **WHEN** a single classifier call completes
- **THEN** its request and response events SHALL carry the same effect id
- **AND** both SHALL resolve to the one trace id of the workflow

#### Scenario: Classifier events join the agent session events of the run

- **WHEN** a workflow's telemetry stream contains classifier events and pi runtime session events
- **THEN** a trace consumer grouping by trace id SHALL see them as spans of one workflow trace

### Requirement: Routing telemetry is bounded, content-free, and redacted

Classifier telemetry SHALL NOT export the workflow task text, collected artifact content, question instructions, classifier answer text, prompts, or model output; it SHALL export only scalar counts, sizes, statuses, confidences, and labels. Every exported string SHALL have known credential shapes redacted before it is written, and SHALL be bounded by the shared telemetry attribute limit. A value that is not a string, number, or boolean SHALL be omitted.

#### Scenario: No prompt or artifact content reaches the stream

- **WHEN** a classifier call classifies a change whose planning artifacts contain source code and prose
- **THEN** the exported classifier events SHALL contain the artifact count and byte sizes only
- **AND** no substring of the task text, the artifact content, the question instructions, or the provider's answer text SHALL appear in the exported rows

#### Scenario: Credential-shaped values are redacted

- **WHEN** a reported label, profile name, or error class contains a credential-shaped value
- **THEN** the exported value SHALL be redacted before it is written to the telemetry stream

### Requirement: Routing telemetry is observational only

Emitting classifier telemetry SHALL NOT change the classification result, the workflow's pinned model selection, or any workflow transition. A failure to build, bound, redact, write, or export a classifier payload SHALL be swallowed, and the workflow SHALL remain runnable. Classifier telemetry SHALL NOT read or mutate workflow state, retry or re-issue a classifier call, or switch a model or profile.

#### Scenario: Telemetry failure leaves the call untouched

- **WHEN** writing or exporting a classifier event fails during a call
- **THEN** the call's result SHALL still be applied and the workflow SHALL continue
- **AND** no attention entry naming telemetry SHALL be recorded

#### Scenario: Telemetry never re-issues a call

- **WHEN** a classifier call's telemetry is emitted
- **THEN** no additional classifier call SHALL be made on its behalf

## REMOVED Requirements

### Requirement: Every completed classification pass exports one decision record

**Reason**: There are no classifier routing passes any more. Per-step models are
resolved and pinned at workflow start, so there is no pass whose selected label,
confidence, fallback flag, and pinned profiles would be reported.

**Migration**: Read the pinned per-step model and its source from the workflow's
metadata, and the start-time `models.selected` telemetry event
(spec: `orchestrator-step-model-selection`). The classifier call telemetry for
triage, gates, and file judgment is unaffected.
