# stage-gates Specification

## Purpose
Defines the configurable stage gates of the workflow engine: how a preset
declares that plan approval, verification, developer review, or wiki
documentation may be skipped, how the classifier decides each gate, how the
workflow routes around a skipped stage, and what auditable record a skip leaves
behind.

## Requirements

### Requirement: Stage gate policies are configured per preset

Configuration SHALL accept a `gates` table on an agent configuration preset with
one entry per stage — `planApproval`, `verification`, `developerReview`, and
`wiki` — and a global `gates` table in the agents configuration as the fallback
for presets that declare no entry for a stage. Each declared value SHALL be
either `always` or `auto`. A stage resolved from a preset entry SHALL take
precedence over the global table, the global table over the default, and the
default SHALL be `always`. A configuration declaring a stage that is not one of
the four, or a value that is not `always` or `auto`, SHALL be rejected before any
workflow starts, naming the offending stage and value. The resolved policy of
each stage SHALL be readable by the running workflow that selected the preset,
and SHALL NOT change during that workflow's lifetime.

#### Scenario: No gate configuration runs every stage

- **WHEN** a workflow starts with a preset and a configuration that declare no
  `gates` table on the preset and none in the global agents table
- **THEN** every stage's resolved policy SHALL be `always`

#### Scenario: Preset entry overrides the global table

- **WHEN** the global agents table sets a stage to `auto` and the selected preset
  sets the same stage to `always`
- **THEN** that stage's resolved policy SHALL be `always` for the workflow

#### Scenario: Global table applies to presets without an entry

- **WHEN** the global agents table sets a stage to `auto` and the selected preset
  declares no `gates` entry for that stage
- **THEN** that stage's resolved policy SHALL be `auto` for the workflow

#### Scenario: Unknown stage or value is rejected

- **WHEN** configuration parsing encounters a `gates` entry naming an unknown
  stage or a value other than `always` or `auto`
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the diagnostic SHALL name the stage and the offending value

### Requirement: A mandatory gate decides locally and issues no classifier request

A stage whose resolved policy is `always` SHALL be decided locally as a forced
run: the gate SHALL complete without contacting the classifier, SHALL issue no
classifier request for that stage, and SHALL route the workflow into the stage it
guards. A stage whose resolved policy is `auto` SHALL be the only case in which
the classifier may decide that stage.

#### Scenario: A mandatory gate runs without a classifier call

- **WHEN** a workflow reaches a gate whose resolved policy is `always`
- **THEN** no classifier request SHALL be issued for that stage
- **AND** the workflow SHALL enter the guarded stage

#### Scenario: An automatic gate asks the classifier

- **WHEN** a workflow reaches a gate whose resolved policy is `auto`
- **THEN** the classifier SHALL be asked exactly one boolean-necessity question
  for that stage
- **AND** no model pool, profile, or preset pool SHALL be resolved to answer it

### Requirement: A gate runs its stage at or above the necessity threshold

An automatic gate SHALL run its guarded stage when the classifier's answer for
that stage reaches a necessity value of 0.5, and SHALL skip it only when the
answer is below 0.5. A necessity answer SHALL NOT be filtered, weighted, or
re-scored by any other field, and no answer field other than the necessity value
SHALL be consulted. The classifier SHALL reuse the same endpoint and profile
used by the workflow's other classifier routing.

#### Scenario: Answer at the threshold runs the stage

- **WHEN** an automatic gate's necessity answer is exactly 0.5
- **THEN** the guarded stage SHALL run

#### Scenario: Answer below the threshold skips the stage

- **WHEN** an automatic gate's necessity answer is below 0.5
- **THEN** the guarded stage SHALL be skipped
- **AND** the workflow SHALL route to the skip target of that gate

### Requirement: Each gate guards only its own stage

The plan gate SHALL guard only the plan approval stage and SHALL be present only
in a definition that has a plan approval stage. The review gate SHALL guard only
the developer review stage and SHALL be present only in a definition that has a
developer review stage. The wiki gate SHALL guard the wiki documentation stage
and its approval and SHALL be present only in a definition that has a wiki gate.
The verification gate SHALL guard the triage and verification stages together
(SHALL be described further under the verification gate requirement below). A
gate SHALL have exactly two outcomes — a run outcome and a skip outcome — and the
skip outcome SHALL target the same step the guarded stage's own approval or
completion outcome targets, so that a skip is indistinguishable in shape from an
approval.

#### Scenario: The plan gate is absent without a plan approval stage

- **WHEN** a definition has no plan approval stage
- **THEN** that definition SHALL contain no plan gate step

#### Scenario: The plan gate runs into plan approval

- **WHEN** a plan gate in a full implementation flow reports a run
- **THEN** the workflow SHALL enter the plan approval stage and SHALL remain
  active with the plan approval actions available

#### Scenario: The plan gate skips to the approval target

- **WHEN** a plan gate reports a skip
- **THEN** the workflow SHALL enter the step that the plan approval stage's
  approval outcome targets, without the plan approval actions ever being offered

#### Scenario: The plan gate skips in a proposal-only flow

- **WHEN** a plan gate reports a skip in a proposal-only definition
- **THEN** the workflow SHALL enter that definition's completion step
- **AND** it SHALL not create implementation, verification, archive, delivery, or
  pull-request effects

#### Scenario: The review gate guards developer review

- **WHEN** a verification round passes and its review gate reports a run
- **THEN** the workflow SHALL enter the developer review stage

#### Scenario: The review gate skips to the tail

- **WHEN** a review gate reports a skip in a definition that has a wiki gate
- **THEN** the workflow SHALL enter the wiki gate
- **AND** in a definition without a wiki gate it SHALL enter that definition's
  archive or delivery step directly

#### Scenario: The wiki gate guards wiki documentation

- **WHEN** a wiki gate reports a run
- **THEN** the workflow SHALL enter the wiki documentation stage and its
  subsequent approval, exactly as an unconditional wiki step would

#### Scenario: The wiki gate skips to the archive

- **WHEN** a wiki gate reports a skip in a definition that has an archive step
- **THEN** the workflow SHALL enter the archive step
- **AND** in a definition without an archive step it SHALL enter delivery

#### Scenario: Documentation-only and research lifecycles are not gated

- **WHEN** a lifecycle's only gated-shaped stage is the whole purpose of the
  workflow, as in the standalone wiki workflow, or the lifecycle has no gated
  stage, as in the research workflow
- **THEN** that lifecycle SHALL contain no gate step and SHALL keep its previous
  graph

### Requirement: The verification gate decides triage and verification together

The verification gate SHALL be one decision that guards the triage stage and the
verification stage as a single unit, and it SHALL be taken at the routing step
that already precedes triage in the implementation loop. When the classifier
reports that independent verification is not needed, the routing step SHALL take
a distinct skip outcome that bypasses both the triage stage and the verification
stage. When it reports that verification is needed, the routing step SHALL
continue into triage and verification as it did before this change. A round that
the classifier reduces to zero domain verifier roles SHALL still run the
engine-owned full test suite, and that reduction SHALL NOT be treated as a skip.
There SHALL be no configuration that runs verification without triage, and no
configuration that gates them separately.

#### Scenario: Verification not needed skips triage and verification

- **WHEN** the classifier reports that independent verification is not needed
- **THEN** the workflow SHALL skip both the triage stage and the verification
  stage for that round
- **AND** no verifier run and no triage run SHALL be created

#### Scenario: Verification needed continues into triage

- **WHEN** the classifier reports that independent verification is needed and at
  least one domain verifier role is selected
- **THEN** the workflow SHALL enter the triage stage and then the verification
  stage

#### Scenario: Zero roles is a reduction, not a skip

- **WHEN** the classifier reports that verification is needed but selects no
  domain verifier role
- **THEN** the triage stage SHALL be bypassed and the verification stage SHALL
  still run the engine-owned full test suite
- **AND** the round SHALL NOT be recorded as a skipped gate

#### Scenario: A mandatory verification gate always runs the round

- **WHEN** the verification gate's resolved policy is `always`
- **THEN** no necessity question for that gate SHALL be asked
- **AND** every round SHALL continue into triage or, for a zero-role round, into
  the verification stage

### Requirement: A skipped verification round still reaches developer review

A workflow SHALL be able to skip both the verification stage and the developer
review stage only when both gates resolve to `auto`, and this SHALL follow from
the graph rather than from a second rule: a skip of the verification gate SHALL
route into the review gate, and the review gate SHALL skip only when the
developer review policy is itself `auto`. No gate step SHALL have an outcome
that routes directly from a skipped verification gate into the archive, the wiki
gate, or delivery.

#### Scenario: Developer review still runs after a verification skip

- **WHEN** the verification gate is `auto` and skips a round, and the developer
  review policy is `always`
- **THEN** the review gate SHALL report a run and the developer review stage
  SHALL execute

#### Scenario: Both stages are skipped only when both are automatic

- **WHEN** the verification gate is `auto` and skips a round, and the developer
  review policy is `auto`
- **THEN** the review gate MAY report a skip and the developer review stage SHALL
  be bypassed

### Requirement: A gate failure never skips a stage

A gate SHALL never skip its stage on the basis of a failed decision. A classifier
error, a missing credential, an unparsable response, a missing answer key, or an
answer that carries no usable necessity value SHALL force the guarded stage to
run and SHALL record an attention entry naming the failure. A forced run SHALL
be recorded as a decision of that gate, distinguishing it from an answered run.

#### Scenario: Classifier failure forces the stage

- **WHEN** a gate's classifier request fails or returns an unusable body
- **THEN** the guarded stage SHALL run
- **AND** the workflow SHALL record an attention entry naming the failure rather
  than entering attention-required

#### Scenario: Unusable answer forces the stage

- **WHEN** a gate's answer is missing or carries no numeric necessity value
- **THEN** the guarded stage SHALL run
- **AND** the recorded decision SHALL identify the run as forced

#### Scenario: A mandatory gate is never a classifier failure

- **WHEN** a gate's resolved policy is `always` and no classifier request is
  issued
- **THEN** the stage SHALL run and the decision SHALL be recorded without an
  attention entry

### Requirement: The OpenSpec archive stage is never gated

The archive stage SHALL NOT be guarded by any gate, SHALL remain a registered
step of every definition that archives, and SHALL remain reachable on every
path that reaches the end of a workflow. A skipped gate SHALL route around its
own stage only, and the graph SHALL contain no outcome that bypasses the archive
step of a definition that has one.

#### Scenario: Every archiving definition still archives

- **WHEN** every gate of an archiving definition is `auto` and every one of them
  reports a skip
- **THEN** the workflow SHALL still enter the archive step

#### Scenario: Wiki skip enters the archive

- **WHEN** a wiki gate reports a skip in a definition that has an archive step
- **THEN** the archive step SHALL be entered, never delivery

#### Scenario: No archive gate exists

- **WHEN** the registered step catalog is inspected
- **THEN** no gate step SHALL guard the archive step

### Requirement: Every gate decision is auditable

The workflow SHALL retain a bounded, ordered record of every gate decision it
takes, and each record SHALL identify the stage, the resolved policy, the stage's
necessity answer when one was obtained, whether the decision was forced or
answered, and whether the stage ran or was skipped. The record list SHALL be
carried by the validated workflow view and rendered by the dashboard, and the
dashboard SHALL additionally surface each skipped stage. An actual skip SHALL
emit a developer notification and a telemetry event naming the skipped stage and
its answer value, so a skipped test suite or human review is never silent. The
record list SHALL keep a fixed maximum record count and a fixed maximum aggregate
size, dropping the oldest records first, and a workflow that has taken no gate
decision SHALL expose an empty list rather than failing.

#### Scenario: A skip is recorded and surfaced

- **WHEN** a gate reports a skip
- **THEN** the record list SHALL contain a record naming the stage, the resolved
  policy, the answer value, and the skip
- **AND** the workflow status surface and the dashboard SHALL both show the
  skipped stage

#### Scenario: A skip emits a notification and a telemetry event

- **WHEN** a gate reports a skip
- **THEN** a developer notification SHALL be raised naming the skipped stage
- **AND** a telemetry event SHALL name the skipped stage and its answer value

#### Scenario: A forced run is recorded as forced

- **WHEN** a stage runs because the decision failed or the policy is `always`
- **THEN** the record SHALL identify the decision as forced and SHALL NOT report
  a skip

#### Scenario: The record list stays bounded

- **WHEN** more gate decisions are taken than the record bound allows
- **THEN** the oldest records SHALL be dropped and the newest SHALL be retained
- **AND** taking a decision SHALL never fail because a record could not be
  stored

#### Scenario: A workflow without gate decisions exposes an empty list

- **WHEN** the workflow view is read for a workflow that has taken no gate
  decision
- **THEN** the gate decision list SHALL be empty
- **AND** the view SHALL still decode

### Requirement: Gate decisions are made from bounded, stage-specific state

The state given to a gate SHALL be assembled for the stage being decided and
SHALL stay bounded: the plan approval gate SHALL read the change's planning
artifacts, the verification gate SHALL read the engine's changed-file manifest
with per-file and total diff caps, the developer review gate SHALL read the
bounded diffs together with the round's verification results, and the wiki gate
SHALL read the plan summary with a changed-file summary. Changed-file evidence
SHALL come from the same engine observation the workflow validates triage
scoping against, every changed-file path SHALL appear in full even when its diff
text is truncated or omitted, and the collected material SHALL be presented to
the classifier as untrusted repository data that cannot direct the answer.

#### Scenario: Diff caps keep every path

- **WHEN** the collected diff text exceeds a per-file or total byte cap
- **THEN** diff text SHALL be truncated deterministically
- **AND** every remaining changed-file path SHALL still be listed in full

#### Scenario: Each stage reads its own material

- **WHEN** each of the four gates is decided
- **THEN** the plan gate SHALL read the planning artifacts, the verification gate
  the changed files and capped diffs, the review gate the diffs together with
  the verification results, and the wiki gate the plan with a changed-file summary

#### Scenario: Collected material cannot direct the answer

- **WHEN** a collected path, diff, or artifact contains text addressing the
  classifier's questions or claiming to be a system instruction
- **THEN** that text SHALL be treated as repository data under review
- **AND** the request SHALL state that the collected material is data and never
  instructions
