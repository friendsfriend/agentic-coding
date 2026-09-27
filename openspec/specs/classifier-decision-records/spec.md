# classifier-decision-records Specification

## Purpose
Records every decision a workflow's classifier made — the input it was given,
the options it was offered, the answer it returned, and the result that was
actually applied — so the decision can be inspected after the fact instead of
being inferred from the pinned routing.

## Requirements

### Requirement: One decision record per answered classifier question

When a classifier effect completes, the workflow SHALL retain one decision
record per answered question of that request, in request order. Each record
SHALL carry the classifier integration that produced it, the asked question's
identifier, the classifier model, the classifier input, the options that were
offered (each with its label, the profile it names, and its criteria), the
model's answer (its type, chosen label, confidence and probabilities), and the
result (whether the answer was applied, the profiles applied, and any attention
note). A question the classifier did not answer SHALL still be recorded, with
its no-answer type and the fallback result.

#### Scenario: Routing pass records one record per classifiable step

- **WHEN** a routing pass completes for a definition with `core.plan` and `core.verification` classified
- **THEN** the workflow SHALL hold one decision record for `core.plan` and one for `core.verification`
- **AND** each record's options SHALL be that step's pool entries as they were asked

#### Scenario: Unanswered question is recorded with its fallback

- **WHEN** a routing pass completes and the classifier returned no usable answer for a step
- **THEN** a decision record SHALL exist for that step
- **AND** its answer type SHALL be the no-answer type
- **AND** its result SHALL record that the answer was not applied and name the profiles kept

#### Scenario: Record matches the applied routing

- **WHEN** a decision record is written for a step
- **THEN** its result's applied profiles SHALL be the profiles the workflow actually pinned for that step

### Requirement: Decision records are integration-keyed

A decision record SHALL identify the classifier integration that produced it and SHALL NOT be shaped by any single integration's routing vocabulary. A question identifier and a pass discriminator MAY be carried when the integration defines them. A workflow that runs more than one classifier integration SHALL keep the records of every integration in the same ordered history, each attributed to its own integration.

#### Scenario: A second integration records into the same history

- **WHEN** a classifier integration other than routing records a decision
- **THEN** the record SHALL be appended to the same ordered decision history
- **AND** the record's integration SHALL identify the integration that produced it
- **AND** no existing record's shape SHALL change

#### Scenario: Records are ordered by decision time

- **WHEN** several decisions have been recorded for a workflow
- **THEN** they SHALL be returned oldest first with the time each was recorded

### Requirement: Decision records are bounded and never fail a classification

A workflow SHALL keep its decision history within a fixed record count and a
fixed aggregate content size. When recording a decision would exceed either
bound, the workflow SHALL drop the oldest records until the new record fits,
SHALL truncate the stored classifier input to a per-record size limit, and SHALL
mark the record as truncated. A classifier effect that produced a decision SHALL
NOT be failed because the decision could not be recorded. A stored classifier
input SHALL be marked as truncated whenever it was shortened.

#### Scenario: Input beyond the per-record limit is marked truncated

- **WHEN** a recorded classifier input exceeds the per-record size limit
- **THEN** the record SHALL hold a shortened classifier input
- **AND** the record SHALL be marked as truncated

#### Scenario: Count bound drops the oldest records

- **WHEN** a new decision would exceed the record count bound
- **THEN** the oldest records SHALL be dropped until the new record fits
- **AND** the new decision SHALL be recorded

#### Scenario: Recording never fails the classifier effect

- **WHEN** a classifier effect completes and its decision cannot be recorded
- **THEN** the classifier effect SHALL still be treated as completed
- **AND** the workflow SHALL remain runnable

### Requirement: Decision records are exposed through the validated workflow view

The validated workflow view SHALL carry the workflow's decision records and the
dashboard state SHALL carry them from that view. A workflow that has recorded no
decisions SHALL expose an empty list rather than omitting the field. A stored
workflow that predates decision recording SHALL still be readable and SHALL
expose no decisions.

#### Scenario: View carries the recorded decisions

- **WHEN** the dashboard reads the workflow view of a run that classified
- **THEN** the view SHALL carry that run's decision records
- **AND** the dashboard state SHALL carry the same records

#### Scenario: Run without decisions exposes an empty list

- **WHEN** the workflow view is read for a run that recorded no decision
- **THEN** the view SHALL expose an empty decision list

#### Scenario: Stored run without the field remains readable

- **WHEN** a stored workflow predates decision recording
- **THEN** it SHALL decode successfully
- **AND** it SHALL expose no decision records
