# Spec Delta

## MODIFIED Requirements

### Requirement: Classifiable step mode metadata

The workflow SHALL declare a classification mode for each classifiable step
through that step's own registered behavior: `single` for a step whose model is
one pool entry, `roster` for `fusion.plan`. Every clique-bearing agent step
SHALL be classifiable, including `core.research`; no other step SHALL be
classifiable and no other step SHALL be asked a pool question by a routing pass.
The classifiable set SHALL be derived from the registered step behaviors, so a
step cannot be classifiable in one consumer and not in another. All verifier
roles of `core.verification` SHALL share that step's single pool. Classifier
integrations that resolve no model pool SHALL be distinct from this metadata:
they SHALL be asked through their own integration identifier, SHALL NOT consume
a pool, and SHALL NOT make a step classifiable.

#### Scenario: Only classifiable steps are asked

- **WHEN** a routing pass builds its question
- **THEN** it SHALL include exactly the classifiable step it was created for
- **AND** it SHALL include no question for any other step

#### Scenario: Research is classifiable

- **WHEN** a `research` definition reaches its research step
- **THEN** the routing pass for that step SHALL ask the `core.research` pool

#### Scenario: Verifier roles share one pool

- **WHEN** triage selects several verifier roles for a round
- **THEN** every selected verifier role SHALL resolve through the one profile the classifier selected for `core.verification`
- **AND** no per-verifier-role pool or profile field SHALL be consulted

#### Scenario: A non-pool integration asks the classifier

- **WHEN** a classifier integration that resolves no model pool is invoked
- **THEN** no pool entry SHALL be read for it
- **AND** the pinned model routing SHALL be left unchanged

### Requirement: Classifier coverage validation

At workflow start and at preset switch the system SHALL verify that every
classifiable step present in the resolved definition has a valid pool in the
effective preset, for every workflow family — a routed workflow is no longer
identified by the presence of a plan-phase routing step. A workflow started with
no preset SHALL fail before any agent launches, and every coverage or
missing-preset failure SHALL point at Settings → Presets and SHALL name the
step.

#### Scenario: Start validates pool coverage

- **WHEN** a workflow whose resolved definition contains a classifiable step starts with a preset lacking that step's pool
- **THEN** startup SHALL fail before launching any agent
- **AND** the error SHALL name the step and point at Settings → Presets

#### Scenario: Every family validates coverage

- **WHEN** a `no-openspec`, `wiki`, `research`, or OpenSpec-family workflow starts
- **THEN** its classifiable steps SHALL each require a pool exactly as an OpenSpec-family start does

#### Scenario: Preset switch validates pool coverage

- **WHEN** an active workflow switches to a preset lacking a pool for a classifiable step in its resolved definition
- **THEN** the switch SHALL be rejected with the Settings → Presets hint
- **AND** the previously pinned routing SHALL remain in effect

## ADDED Requirements

### Requirement: Per-step classifier routing

Every classifiable agent step SHALL be preceded by a routing step in the same
definition. The routing step SHALL enqueue exactly one `model.classify` routing
effect naming the step that follows, and SHALL transition to that step whichever
way the classification ends, so a fail-open result runs the step with its pinned
default rather than parking the workflow. A routing step SHALL be a system step
with the single `complete` outcome and `model.classify` as its only allowed
effect.

#### Scenario: A model is selected immediately before its step runs

- **WHEN** the workflow arrives at a classifiable step
- **THEN** the route step SHALL run first and ask exactly that step's pool question
- **AND** the step SHALL then run with the selected profile

#### Scenario: A loop re-selects the model

- **WHEN** a step loops back to itself through its route step
- **THEN** the classifier SHALL be asked again for that step
- **AND** the loop's attempt budget SHALL be unchanged from the pre-routing graph

#### Scenario: A routing outage does not park the workflow

- **WHEN** the routing classification fails open or is unavailable
- **THEN** the route step SHALL still complete and the step SHALL run with its pinned default
- **AND** the workflow SHALL record an attention entry rather than waiting at the route step

### Requirement: Routing state matches the step

The routing request SHALL carry the state that step is about to run against: the
task alone before a plan step, and the task plus the change's planning artifacts
and changed-file paths for a step that runs after planning. Diff bodies SHALL NOT
be sent, and the state SHALL stay within the classifier's existing byte budget.

#### Scenario: Pre-plan step sees the task

- **WHEN** the route step for a plan-phase step builds its request
- **THEN** the state SHALL be the task only

#### Scenario: Post-plan step sees the change

- **WHEN** the route step for a step that runs after planning builds its request
- **THEN** the state SHALL carry the task, the planning artifacts, and the changed-file paths
- **AND** it SHALL NOT carry diff bodies
