# workflow-developer-question Specification

## Purpose
Give managed agents a safe, durable way to pause on an unclear decision and obtain explicit developer guidance through the workflow dashboard.

## Requirements

### Requirement: Authenticated developer question interface
Every active managed agent SHALL be able to submit a bounded developer question containing a description and zero or more recommended options, and SHALL receive the developer's selected option, custom response, or explicit cancellation. The interface SHALL authenticate the request against the active run capability and SHALL not allow an agent to identify another run or workflow.

#### Scenario: Agent asks with recommended options
- **WHEN** an active managed agent invokes `developer_question` with a non-empty description and recommended options
- **THEN** the workflow SHALL durably enqueue the question with its workflow, run, step, and role identity
- **AND** the invocation SHALL wait for the corresponding developer response
- **AND** selecting a recommended option SHALL return that option's value to the requesting agent

#### Scenario: Developer supplies a custom response
- **WHEN** the developer chooses the custom-response path and submits non-empty text
- **THEN** the pending question SHALL be answered with that text
- **AND** the requesting agent SHALL receive the custom text as its tool result

#### Scenario: Question request is invalid or unauthorized
- **WHEN** a request has an invalid description/options payload, an expired or wrong run capability, or no active run
- **THEN** the workflow SHALL reject it without creating a question or changing workflow lifecycle state
- **AND** the diagnostic SHALL not disclose another workflow's state or capability

#### Scenario: No interactive developer channel is available
- **WHEN** a question is requested while no dashboard can answer it before the bounded wait expires
- **THEN** the interface SHALL return a bounded error or cancellation result
- **AND** the managed agent process SHALL not remain blocked indefinitely

### Requirement: Dashboard question modal
The dash SHALL surface pending developer questions in a modal independently of the current workflow phase or busy effect drain. The modal SHALL display the question description, allow navigation and selection of recommended options, and always offer a custom text response.

#### Scenario: Pending question opens
- **WHEN** a valid question is pending for a workflow shown by the dash
- **THEN** the dash SHALL show the oldest unanswered question with its requesting role and recommended options
- **AND** normal dashboard content SHALL remain behind the modal

#### Scenario: Recommended option is selected
- **WHEN** the developer confirms a recommended option
- **THEN** the dash SHALL submit the response for that exact question using the current workflow revision
- **AND** the modal SHALL close or advance to the next queued question only after the engine accepts the response

#### Scenario: Custom response is submitted
- **WHEN** the developer enters non-empty custom text and submits it
- **THEN** the dash SHALL send that text as the response to the displayed question
- **AND** the requesting tool SHALL receive the same text without dashboard-only formatting

#### Scenario: Question is cancelled
- **WHEN** the developer presses Escape or otherwise cancels the displayed question
- **THEN** the pending request SHALL be resolved as cancelled
- **AND** the requesting agent SHALL receive a cancellation result rather than waiting forever

#### Scenario: Concurrent questions are queued
- **WHEN** multiple active agents ask questions before the developer answers them
- **THEN** the dash SHALL present them one at a time in stable creation order
- **AND** answering one question SHALL not answer, overwrite, or discard another question

### Requirement: Shared developer dialogue
The workflow SHALL retain a bounded, ordered dialogue record for each question and response, including requester role and step identity, and SHALL expose the record through the validated workflow view and future managed-agent assignments. Dialogue content SHALL be marked as developer-provided context and treated as untrusted text by agents.

#### Scenario: Later agent receives prior decision
- **WHEN** a question has been answered and a later planner, worker, or verifier assignment is rendered for the same workflow
- **THEN** the assignment SHALL include the available prior question and answer history
- **AND** the history SHALL include security-verifier assignments when they are launched later

#### Scenario: Dialogue survives workflow refresh
- **WHEN** the dash or an agent reloads the workflow after a question is answered
- **THEN** the same ordered dialogue record SHALL remain available from canonical workflow state
- **AND** runtime observations or pane status SHALL not be the source of truth for the record

#### Scenario: Dialogue bounds are reached
- **WHEN** a new question or answer would exceed the workflow's configured count or content bounds
- **THEN** the request SHALL fail with an actionable bounded diagnostic
- **AND** existing dialogue history SHALL remain unchanged

### Requirement: Sensitive question handling
Question and answer content SHALL be bounded at input validation, excluded from telemetry and ordinary operational diagnostics unless explicitly requested by the developer, and protected by the same run/workflow authorization boundary as other agent commands.

#### Scenario: Question content is recorded
- **WHEN** a question or answer is committed
- **THEN** the event and view SHALL identify the question without exposing run tokens or unrelated workflow data
- **AND** telemetry SHALL record only non-content metadata such as question identity, role, and outcome

#### Scenario: Stale response is submitted
- **WHEN** a response targets an already answered, cancelled, expired, or replaced question
- **THEN** the engine SHALL reject it without changing dialogue history
- **AND** the dash SHALL refresh and present the current pending question state
