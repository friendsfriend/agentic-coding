# Spec Delta

## MODIFIED Requirements

### Requirement: Per-round classifier-driven verifier role selection

Every verification round SHALL pass through a `core.triage-route` system step
before `core.triage` in the shared implementation loop. The step SHALL enqueue
exactly one classifier request carrying one independent question per eligible
verifier role and SHALL resolve the roles whose answers reach the 0.5
inclusion threshold. Eligible roles SHALL be the registered verifier role
catalog minus the engine-owned full-suite role, with the OpenSpec verifier role
additionally excluded for definitions that declare no OpenSpec surface. No role
SHALL be selected by a forced baseline: the correctness and OpenSpec verifier
roles SHALL be classifier-decided like every other role, and selecting zero
roles SHALL be a valid outcome. The same request SHALL additionally carry the
verification gate's single question of whether the change needs independent
verification before it is archived, and the step SHALL have a third outcome,
distinct from an empty role selection, that bypasses both `core.triage` and
`core.verification` for the round. The gate question SHALL be asked only when
the verification gate's resolved policy permits the classifier to decide it; a
resolved policy of `always` SHALL take the round's continuing outcome without
asking. Stage gate semantics are specified by the `stage-gates` capability.

#### Scenario: Implementation enters the routing step

- **WHEN** `core.implementation` completes
- **THEN** the definition SHALL enter `core.triage-route` before `core.triage`
- **AND** entering the step SHALL enqueue one classification effect that is the
  step's only allowed external effect

#### Scenario: Confident answers select roles

- **WHEN** the classifier answers with a value of at least 0.5 for two of the
  eligible role questions and below 0.5 for the rest
- **THEN** exactly those two roles SHALL be selected for the round
- **AND** the step SHALL continue to `core.triage`

#### Scenario: Zero roles selected

- **WHEN** every eligible role question is answered below 0.5
- **THEN** the routing step SHALL report an empty selection
- **AND** the definition SHALL skip `core.triage` and enter `core.verification`
  with no domain verifier selected

#### Scenario: The full-suite role is never a question

- **WHEN** the routing step builds its classifier questions
- **THEN** it SHALL NOT ask about the engine-owned full-suite verifier role
- **AND** that role SHALL remain the engine's automatic launch after the
  selected verifiers report

#### Scenario: OpenSpec verifier is not asked without an OpenSpec surface

- **WHEN** the resolved definition declares no OpenSpec surface
- **THEN** no question SHALL be asked for the OpenSpec verifier role
- **AND** the remaining eligible roles SHALL still be asked

#### Scenario: Routing repeats for every verification round

- **WHEN** a verification round ends in a fix outcome and implementation runs
  again
- **THEN** the definition SHALL enter the routing step again before the next
  `core.triage`

#### Scenario: The gate question travels with the role questions

- **WHEN** the verification gate's policy permits the classifier to decide it
- **THEN** the routing step's single request SHALL carry the role questions and
  the verification gate question together
- **AND** it SHALL NOT issue a second request for the gate question

#### Scenario: The gate question is not asked under a mandatory policy

- **WHEN** the verification gate's resolved policy is `always`
- **THEN** no gate question SHALL be asked
- **AND** the round SHALL continue into triage or verification without a skip
  outcome being possible

#### Scenario: Verification is reported as unnecessary

- **WHEN** the gate question is answered below 0.5
- **THEN** the routing step SHALL take its skip outcome
- **AND** the definition SHALL bypass both `core.triage` and `core.verification`
  and continue with the developer review gate

### Requirement: Classifier failure never blocks verification

A classification failure — a missing credential, a provider error, an invalid
response body, answers with no usable value, **or a partially answered
classification** — SHALL NOT stop the workflow. The routing step SHALL let
`core.triage` run unconstrained, exactly as it did before this change, and the
workflow SHALL record an `attention` entry naming the failure.
The full-suite verifier role SHALL remain reachable in that round. A selection
that is not complete SHALL NOT be used to narrow the round, and a zero-role
selection SHALL still be recorded in `attention` so a skipped gate is never
silent. A failure of the verification gate question SHALL never skip the round:
the routing step SHALL take its continuing outcome so triage and verification
still run, and the failure SHALL be recorded as a forced run with an `attention`
entry.

#### Scenario: Missing credential fails open

- **WHEN** the classifier request cannot be sent because its credential is
  absent
- **THEN** `core.triage` SHALL run with the full eligible role catalog available
- **AND** the workflow SHALL record an `attention` entry

#### Scenario: Provider failure fails open

- **WHEN** the classifier provider returns an error or an unparsable body
- **THEN** the routing step SHALL still complete
- **AND** the workflow SHALL continue to an unconstrained `core.triage` with an
  `attention` entry rather than entering attention-required

#### Scenario: Gate failure still runs the round

- **WHEN** the verification gate question cannot be obtained or carries no usable
  value
- **THEN** the routing step SHALL NOT take its skip outcome
- **AND** the round SHALL proceed to triage or verification with an `attention`
  entry naming the gate failure
