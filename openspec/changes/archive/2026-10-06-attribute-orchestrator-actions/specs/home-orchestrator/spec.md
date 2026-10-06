# Spec Delta

## ADDED Requirements

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
