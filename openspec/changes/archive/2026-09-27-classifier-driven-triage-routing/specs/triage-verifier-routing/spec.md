# Spec Delta

## Purpose

Define how the JEV classifier decides which verifier roles run in each
verification round from a bounded view of the change, how the triage agent is
narrowed to scoping those roles to changed files, and what happens when the
classifier selects nothing or cannot answer at all.

## ADDED Requirements

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
roles SHALL be a valid outcome.

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

### Requirement: Independent per-role classifier questions

A routing request SHALL carry every eligible role's question in parallel as a
single boolean-necessity question, and each question SHALL be mapped to exactly
one role. A role SHALL be selected when its answer value is at least 0.5 and
SHALL NOT be selected otherwise; the answer SHALL NOT be filtered by any other
field. The classifier SHALL reuse the same endpoint and profile used for model
pool routing, and a routing request SHALL resolve no model, profile, or pool.

#### Scenario: One request asks every eligible role

- **WHEN** the routing step invokes the classifier
- **THEN** exactly one request SHALL carry one question per eligible role
- **AND** it SHALL NOT issue one request per role

#### Scenario: Answer at the threshold is included

- **WHEN** a role question is answered with exactly 0.5
- **THEN** that role SHALL be selected

#### Scenario: Answer below the threshold is excluded

- **WHEN** a role question is answered with a value below 0.5
- **THEN** that role SHALL NOT be selected

#### Scenario: Answer without a usable value

- **WHEN** a role question is missing, malformed, or carries no numeric value
- **THEN** the classification SHALL be treated as incomplete rather than as a
  verdict, and the round SHALL fail open: `core.triage` SHALL run against the full
  eligible catalog and an `attention` entry SHALL name how many questions were answered
- **AND** narrowing a round SHALL require a complete, positive answer set, so a
  truncated response can never be trusted more than an absent one

#### Scenario: Routing resolves no model

- **WHEN** a routing request completes
- **THEN** the workflow's pinned model routing SHALL be unchanged
- **AND** no agent preset pool SHALL be read to answer the questions

### Requirement: Bounded changed-file classification state

The classification state SHALL consist of the task, a bounded plan summary, the
engine's changed-file manifest, and per-file diff text. The manifest SHALL be
produced by the same observation the engine uses to validate triage scoping, so
the classifier sees exactly the files the engine will accept. Total diff bytes
and per-file diff bytes SHALL each be capped, and overflow SHALL truncate
deterministically. Every changed-file path SHALL appear in the state in full
even when its diff text is truncated or omitted.

#### Scenario: Changed manifest matches validated scope

- **WHEN** the routing state is assembled for a round
- **THEN** its changed-file list SHALL be the engine's validated changed-file
  manifest for that round
- **AND** no separate scope derivation SHALL be used

#### Scenario: Diffs exceed the per-file cap

- **WHEN** a single changed file's diff exceeds the per-file byte cap
- **THEN** that file's diff text SHALL be truncated to the cap
- **AND** its path SHALL still be listed in full

#### Scenario: Diffs exceed the total cap

- **WHEN** the collected diff text exceeds the total byte cap
- **THEN** files SHALL be included in a stable order until the cap is reached
- **AND** every remaining changed-file path SHALL still be listed in full with
  no diff text

### Requirement: Triage scopes the classifier-selected roles

The triage agent SHALL receive the classifier selection for the round and SHALL
emit a plan whose roles are a subset of that selection; it MAY drop a selected
role whose files are not relevant and SHALL NOT introduce a role the classifier
did not select. A plan that adds a role, names a role the plan does not scope,
duplicates a role, or scopes a file outside the changed-file manifest SHALL be
rejected. Only the roles the triage plan keeps SHALL reach the verification
step, and each SHALL be scoped to the changed files that role must see.

#### Scenario: Subset is accepted

- **WHEN** the classifier selects three roles and the triage plan scopes two of
  them to changed files
- **THEN** the plan SHALL be accepted
- **AND** exactly those two roles SHALL run for the round

#### Scenario: Adding an unselected role is rejected

- **WHEN** the classifier selected two roles and the triage plan also names a
  third role that was not selected
- **THEN** the plan SHALL be rejected as an invalid verifier role selection
- **AND** no verifier run SHALL launch from that plan

#### Scenario: File outside the changed scope is still rejected

- **WHEN** a triage plan scopes a selected role to a file that is not in the
  changed-file manifest
- **THEN** the plan SHALL be rejected
- **AND** the same rejection SHALL apply regardless of how the role was chosen

#### Scenario: Triage is instructed to scope, not to select

- **WHEN** the triage instruction asset is rendered for a round
- **THEN** it SHALL present the round's role set as already decided
- **AND** it SHALL NOT present a role-selection table or invite a role the
  classifier did not select

#### Scenario: Unconstrained triage after a classifier failure

- **WHEN** triage runs for a round in which the classifier did not produce a
  selection
- **THEN** the plan SHALL be validated against the full eligible role catalog
  rather than an empty set
- **AND** the plan SHALL be accepted or rejected exactly as it was before this
  change

### Requirement: Empty domain selection resolves to the full suite only

A verification step entered with an empty role selection SHALL fan out the
engine-owned full-suite verifier role only. The round SHALL still pass once that
run reports without critical findings, and the engine's automatic launch of the
full suite after the selected verifiers report SHALL remain unchanged for every
round with a non-empty selection.

#### Scenario: Zero-role round runs the suite and passes

- **WHEN** a round reaches verification with no domain verifier selected
- **THEN** the only verifier run SHALL be the engine-owned full-suite role
- **AND** the round SHALL transition to the passing outcome once that run
  reports no critical findings

#### Scenario: Non-empty rounds keep the automatic launch

- **WHEN** a round has at least one selected domain verifier
- **THEN** the engine SHALL still launch the full-suite role exactly once after
  the selected verifiers report and the suite has not already run

### Requirement: Classifier failure never blocks verification

A classification failure — a missing credential, a provider error, an invalid
response body, answers with no usable value, **or a partially answered
classification** — SHALL NOT stop the workflow. The routing step SHALL let
`core.triage` run unconstrained, exactly as it did before this change, and the
workflow SHALL record an `attention` entry naming the failure.
The full-suite verifier role SHALL remain reachable in that round. A selection
that is not complete SHALL NOT be used to narrow the round, and a zero-role
selection SHALL still be recorded in `attention` so a skipped gate is never
silent.

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
