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
hours has reached `max_starts_per_day`. Defaults SHALL be 5 and 20. The refusal
SHALL use status 409 with code `orchestrator-limit` and SHALL name the limit, the
current count and the counted workflows. Starts from the operator principal SHALL
NOT be limited or counted.

#### Scenario: Active limit reached

- **WHEN** five orchestrator-started workflows are active and `max_active` is 5
- **AND** the orchestrator starts another workflow
- **THEN** the server SHALL answer 409 `orchestrator-limit` naming the five
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

### Requirement: Developer questions from orchestrator-started workflows

A developer question created by a run of an orchestrator-started workflow SHALL be routed to the orchestrator session first: the record SHALL carry an orchestrator routing marker, SHALL appear in the orchestrator's workflow observation as an orchestrator question, and SHALL NOT open the developer's question modal while it is unanswered. The orchestrator SHALL be able to answer it or forward it to the developer; forwarding SHALL clear the marker and give the developer a full wait window. While an orchestrator-routed question is pending, the developer SHALL also be able to answer it directly, which clears the marker, so an orchestrator session that is off or idle cannot strand the workflow. A pending orchestrator-routed question SHALL remain visible in the workflow's pending question view so the parked workflow shows what it waits for.

#### Scenario: Question routes to the orchestrator first

- **WHEN** a run of an orchestrator-started workflow creates a developer question
- **THEN** the record SHALL carry the orchestrator routing marker and appear as an orchestrator question
- **AND** the record SHALL NOT appear in the developer's pending developer questions before it is forwarded

#### Scenario: Orchestrator forwards to the developer

- **WHEN** the orchestrator forwards a pending orchestrator-routed question it cannot answer
- **THEN** the marker SHALL be cleared and the wait window reset
- **AND** the question SHALL appear in the developer's pending developer questions

#### Scenario: Developer unblocks an idle orchestrator

- **WHEN** the developer answers a pending orchestrator-routed question while the orchestrator has not answered or forwarded it
- **THEN** the engine SHALL accept the answer, clear the routing marker, and record the developer's answer
- **AND** the asking run SHALL resume under the same rule as a developer-routed question

#### Scenario: Orchestrator question cannot be answered by the wrong actor

- **WHEN** the orchestrator attempts to answer a question that is not routed to it
- **THEN** the engine SHALL reject the answer without changing the question

### Requirement: Home Orchestrator destination and persistent session

The full application's Home SHALL offer an Orchestrator destination that opens
one persistent `pi-durable` conversation hosted by a dedicated agent host in
orchestrator mode. Reopening the page SHALL resume the same conversation, and a
`/new` command SHALL start a new conversation that becomes the active one.

#### Scenario: Opening the Orchestrator resumes the session

- **WHEN** the developer opens Home → Orchestrator after a previous session
- **THEN** the page SHALL show that session's transcript
- **AND** no second conversation SHALL be created

#### Scenario: Starting a new session

- **WHEN** the developer submits `/new`
- **THEN** a new conversation SHALL be created and persisted as the active session

### Requirement: Configurable orchestrator model

The orchestrator session's model and thinking level SHALL be read from
`[agents.orchestrator]` (`model`, `thinking`) in the user configuration, edited
in Settings → Agent Presets, and applied every time the page opens. Absent
fields SHALL use the durable host defaults; unknown keys SHALL be rejected.

#### Scenario: Selected model applies on open

- **WHEN** the developer saves a model and thinking level and reopens the page
- **THEN** the session SHALL run with that model and thinking level

### Requirement: Orchestrator capability and route policy

The unified server SHALL accept an orchestrator capability derived from the
instance token and authenticate it as the `orchestrator` principal. Requests
from that principal SHALL be limited to health, observations, workflow view,
start, action and execute, agents configuration reads, classifier status and
the event stream; any other route SHALL be refused with 403 before any
operation runs. The orchestrator host process SHALL NOT inherit the instance
token.

#### Scenario: Forbidden route

- **WHEN** the orchestrator calls a configuration write, a developer-question
  answer, a review save, a repair or a delete
- **THEN** the server SHALL answer 403 `orchestrator-forbidden`
- **AND** the operation SHALL NOT be invoked

### Requirement: Human reviews stay with the developer

The server SHALL refuse every approval, rejection and review-comment action from
the orchestrator principal. While a workflow's current step is a plan approval,
developer review, findings review or wiki approval, only resume, failed-effect
retry and preset switch SHALL be accepted from the orchestrator. Workflows the
orchestrator starts SHALL pin the plan approval, developer review and wiki gates
to `always`; this SHALL be decided by the server from the principal and SHALL
NOT be expressible in the start request.

#### Scenario: Approval refused at a review step

- **WHEN** the orchestrator sends `approve-plan` while the workflow is at plan
  approval
- **THEN** the server SHALL answer 403 and the workflow SHALL be unchanged

#### Scenario: Orchestrator start keeps reviews

- **WHEN** the orchestrator starts a workflow whose preset sets the developer
  review gate to `auto`
- **THEN** the started workflow SHALL pin the developer review gate as `always`

### Requirement: Orchestrator tool surface

The orchestrator session SHALL be offered exactly the `read` tool and the
orchestrator workflow tools; shell, file writes and codemode SHALL be
unavailable. The workflow tools SHALL call the unified server only with the
orchestrator capability from the session's run environment.

#### Scenario: Shell call is unavailable

- **WHEN** the orchestrator model calls `bash`
- **THEN** the call SHALL fail as unavailable without running a command

