# Spec Delta

## MODIFIED Requirements

### Requirement: Classifiable step mode metadata

The workflow SHALL declare a classification mode for each classifiable step:
`single` for `core.plan`, `fusion.consolidate`, `core.implementation`,
`core.triage`, `core.verification`, `core.wiki`, and `core.archive`; `roster`
for `fusion.plan`. Every other step SHALL NOT be classifiable and SHALL NOT be
asked a pool question by a routing pass. All verifier roles of
`core.verification` SHALL share that step's single pool. Classifier
integrations that resolve no model pool SHALL be distinct from this metadata:
they SHALL be asked through their own integration identifier, SHALL NOT consume
a pool, and SHALL NOT make a step classifiable.

#### Scenario: Only classifiable steps are asked

- **WHEN** a routing pass builds its questions
- **THEN** it SHALL include one question per classifiable step present in the resolved definition and no question for any other step

#### Scenario: Verifier roles share one pool

- **WHEN** triage selects several verifier roles for a round
- **THEN** every selected verifier role SHALL resolve through the one profile the classifier selected for `core.verification`
- **AND** no per-verifier-role pool or profile field SHALL be consulted

#### Scenario: A non-pool integration asks the classifier

- **WHEN** a classifier integration that resolves no model pool is invoked
- **THEN** no pool entry SHALL be read for it
- **AND** the pinned model routing SHALL be left unchanged

### Requirement: Two-pass classifier routing

Classifier routing SHALL run in two passes, each a single System One request
carrying all of that pass's step questions in parallel. `core.route-plan` SHALL
run before planning with the task as state and SHALL ask the `core.plan` and
`fusion.consolidate` pools present in the definition plus, for a fusion
definition, the `fusion.plan` roster. `core.route-apply` SHALL run after plan
approval with the plan artifacts as state and SHALL ask the implementation,
triage, verification, wiki, and archive pools present in the definition. No
other pass SHALL select a model pool, and a classifier integration that resolves
no pool SHALL run outside these two passes without extending them.

#### Scenario: Route-plan resolves pre-approval steps

- **WHEN** a fusion definition starts and reaches `core.route-plan`
- **THEN** the single request SHALL carry the `core.plan`, `fusion.consolidate`, and `fusion.plan` roster questions
- **AND** the state SHALL be the task only

#### Scenario: Route-apply resolves post-approval steps

- **WHEN** a plan is approved and the workflow reaches `core.route-apply`
- **THEN** the single request SHALL carry the implementation, triage, verification, wiki, and archive questions present in the definition
- **AND** the state SHALL be the plan artifacts

#### Scenario: One request per pass

- **WHEN** a routing pass collects questions for several classifiable steps
- **THEN** it SHALL issue exactly one classifier request containing every question in parallel
- **AND** it SHALL NOT issue one request per step

## ADDED Requirements

### Requirement: System One answer shapes

The shared System One client SHALL accept both answer shapes it sends
questions for: a `choice` answer carrying a `choice`, optional `confidence`, and
optional `probabilities`, and a `noul` answer carrying a numeric necessity
value. A malformed, missing, or non-numeric necessity value SHALL parse as an
answer with no usable value rather than as a usable zero, and a `choice` answer
SHALL NOT be produced from a `noul` answer or the reverse.

#### Scenario: Numeric necessity value is parsed

- **WHEN** an answer declares itself a `noul` answer with a finite numeric value
- **THEN** that value SHALL be readable by the caller
- **AND** the answer SHALL NOT be treated as a pool choice

#### Scenario: Non-numeric necessity value collapses

- **WHEN** a `noul` answer omits its value or carries a non-finite or
  non-numeric value
- **THEN** the answer SHALL expose no usable value
- **AND** the caller SHALL treat the question as unanswered rather than as a
  zero answer

#### Scenario: Choice answers are unaffected

- **WHEN** a `choice` answer is parsed
- **THEN** its choice, confidence, and probabilities SHALL be preserved exactly
  as before this capability
