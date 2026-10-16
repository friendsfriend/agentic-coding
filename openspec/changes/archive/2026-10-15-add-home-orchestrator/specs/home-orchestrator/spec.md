# Spec Delta

## Purpose

Define the Home Orchestrator: a persistent chat agent that discovers, starts and
manages workflows through a narrower server capability, while every human review
stays with the developer.

## ADDED Requirements

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
