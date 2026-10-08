# home-orchestrator Specification

## Purpose
TBD - created by archiving change attribute-orchestrator-actions. Update Purpose after archive.
## Requirements
### Requirement: Orchestrator starts and actions are attributed

A workflow started through the orchestrator principal SHALL pin
`startedBy = "orchestrator"` for its lifetime, and a workflow started by the
operator SHALL pin `startedBy = "developer"`; a workflow without the field SHALL
read as `developer`. A developer action accepted from the orchestrator principal
SHALL be recorded with its event actor carrying `principal: "orchestrator"`,
while operator actions SHALL keep their existing actor. Attribution SHALL be
decided by the server from the authenticated principal and SHALL NOT be
expressible in a request.

#### Scenario: Orchestrator-started workflow

- **WHEN** the orchestrator starts a workflow
- **THEN** its view and overview SHALL report `startedBy` as `orchestrator`
- **AND** the workspace sidebar SHALL mark its row

#### Scenario: Orchestrator resumes a workflow

- **WHEN** the orchestrator sends `resume`
- **THEN** the recorded event actor SHALL carry `principal: "orchestrator"`

#### Scenario: Request tries to claim attribution

- **WHEN** a start request includes a `startedBy` field
- **THEN** the server SHALL reject the request as malformed

### Requirement: Orchestrated workflow monitoring

The shell SHALL observe the workflows the orchestrator started while it runs and
`[agents.orchestrator] monitor` is not `off`, and SHALL detect transitions
between successive observations. The first observation of a workflow SHALL only
establish its baseline and SHALL NOT produce a transition. A transition SHALL be
produced when a workflow enters a human review step, acquires a pending
developer question, becomes `attention-required`, gains a failed effect, or
completes.

#### Scenario: First observation is silent

- **WHEN** the monitor first observes a workflow already waiting at plan approval
- **THEN** no transition SHALL be produced

#### Scenario: Review step entered

- **WHEN** an observed orchestrator-started workflow moves into developer review
- **THEN** exactly one review-pending transition SHALL be produced

### Requirement: Developer is told about waiting reviews

For every review-pending or question-pending transition the shell SHALL raise one
notification naming the workflow and its current step, in both `wake` and
`notify` modes.

#### Scenario: Plan waiting on the developer

- **WHEN** an orchestrator-started workflow enters plan approval
- **THEN** the shell SHALL raise one notification naming that workflow and step

### Requirement: Orchestrator session wake-ups

In `wake` mode the shell SHALL deliver transitions to the active orchestrator
session as follow-up input. Transitions within one coalescing window SHALL be
delivered as a single note, and the shell SHALL deliver at most one note per
minute per session, merging any overflow into the next note. In `notify` and
`off` modes no note SHALL be delivered.

#### Scenario: Burst of transitions

- **WHEN** three orchestrator-started workflows change state within the
  coalescing window
- **THEN** the session SHALL receive one note listing all three

#### Scenario: Notify mode

- **WHEN** `monitor` is `notify` and a workflow becomes attention-required
- **THEN** the session SHALL receive no input

### Requirement: Orchestrator launch limits

The server SHALL refuse a workflow start from the orchestrator principal when the
number of orchestrator-started workflows that are neither `completed` nor
`closed`, across all workflow targets, has reached the configured `max_active`,
or when the number of orchestrator-started workflows created in the trailing 24
hours has reached `max_starts_per_day`. Defaults SHALL be 3 and 20. The refusal
SHALL use status 409 with code `orchestrator-limit` and SHALL name the limit, the
current count and the counted workflows. Starts from the operator principal SHALL
NOT be limited or counted.

#### Scenario: Active limit reached

- **WHEN** three orchestrator-started workflows are active and `max_active` is 3
- **AND** the orchestrator starts another workflow
- **THEN** the server SHALL answer 409 `orchestrator-limit` naming the three
  workflows
- **AND** no workflow SHALL be created

#### Scenario: Completed workflows free capacity

- **WHEN** one of those workflows completes
- **THEN** the next orchestrator start SHALL be accepted

#### Scenario: Developer start is unaffected

- **WHEN** the limit is reached and the developer starts a workflow
- **THEN** the start SHALL be accepted

### Requirement: Orchestrator can shape workflows with blueprints

The orchestrator principal SHALL be allowed to read the blueprint step catalog,
validate blueprints, and start blueprint workflows. Blueprint starts from the
orchestrator SHALL keep the human-review gate pin and SHALL count toward the
orchestrator launch limits. The orchestrator session SHALL be offered tools for
these operations and SHALL never submit a manifest directly.

#### Scenario: Orchestrator validates then starts

- **WHEN** the orchestrator validates a blueprint and then starts it
- **THEN** the started workflow SHALL pin the validated digest
- **AND** its plan, developer and wiki gates SHALL be pinned `always`

#### Scenario: Review-free blueprint

- **WHEN** the orchestrator starts a blueprint that bypasses developer review
- **THEN** the server SHALL refuse it with the compiler's diagnostic

