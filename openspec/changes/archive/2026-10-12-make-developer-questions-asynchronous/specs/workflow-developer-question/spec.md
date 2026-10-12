# Spec Delta

## Purpose

Give a managed agent a bounded way to ask, and deliver the answer to the run
that asked even when it arrives after the asking turn has ended.

## MODIFIED Requirements

### Requirement: Authenticated developer question interface
Every active managed agent SHALL be able to submit a bounded developer question containing a description and zero or more recommended options, or an ordered bounded questionnaire containing multiple related questions. Existing single-question payloads SHALL remain supported. Each questionnaire item SHALL have its own description, optional context, and options, and the questionnaire SHALL have a bounded item count and preserve item order. The interface SHALL authenticate the request against the active run capability and SHALL not allow an agent to identify another run or workflow. A question or questionnaire created without a shorter explicit wait SHALL remain pending for up to 24 hours before automatic expiry, and an explicit CLI wait SHALL be accepted only when it is a positive duration no greater than 24 hours. The agent-facing invocation SHALL wait at most a bounded agent grace window that is shorter than the durable expiry; when the window elapses with the record still pending, the invocation SHALL return the pending record and the record SHALL remain pending.

#### Scenario: Agent asks with recommended options
- **WHEN** an active managed agent invokes `developer_question` with a non-empty description and recommended options
- **THEN** the workflow SHALL durably enqueue the question with its workflow, run, step, and role identity
- **AND** the invocation SHALL wait up to the agent grace window for the corresponding developer response
- **AND** an answer received within the window SHALL return that option's value to the requesting agent
- **AND** no answer within the window SHALL return the pending question to the requesting agent

#### Scenario: Agent asks a bounded questionnaire
- **WHEN** an active managed agent invokes `developer_question` with an ordered list of related question items
- **THEN** the workflow SHALL durably enqueue the items as one questionnaire with stable item identity and creation order
- **AND** the invocation SHALL wait up to the agent grace window until every item has a response or the questionnaire is cancelled or expires
- **AND** a completed response set SHALL contain one structured response per item in the original order
- **AND** answering one item SHALL not overwrite, resolve, or discard another item
- **AND** no completed response set within the window SHALL return the pending questionnaire to the requesting agent

#### Scenario: Developer supplies a custom response
- **WHEN** the developer chooses the custom-response path for a question or questionnaire item and submits non-empty text
- **THEN** the pending item SHALL be answered with that text, including newlines and structured formatting
- **AND** the requesting agent SHALL receive the exact custom text either in the corresponding tool result or in the prior dialogue of the attempt that resumes the asking run

#### Scenario: Question request is invalid or unauthorized
- **WHEN** a request has an invalid description, context, options, questionnaire item count, or answer payload, an expired or wrong run capability, or no active run
- **THEN** the workflow SHALL reject it without creating a question or changing workflow lifecycle state
- **AND** the diagnostic SHALL not disclose another workflow's state or capability

#### Scenario: No interactive developer channel is available
- **WHEN** a question or questionnaire is requested while no developer or orchestrator can answer it before the bounded wait expires
- **THEN** the invocation SHALL return the pending record no later than the agent grace window after creation
- **AND** the managed agent process SHALL not remain blocked waiting for an answer

#### Scenario: Default question expiry is 24 hours
- **WHEN** an authenticated managed agent creates a question or questionnaire without an explicit shorter CLI timeout
- **THEN** the durable question records SHALL have an expiry timestamp 24 hours after creation
- **AND** the records SHALL remain pending before that timestamp when no developer response has been received

#### Scenario: Timeout override is bounded by 24 hours
- **WHEN** an authenticated managed agent invokes the CLI question command with `--timeout`
- **THEN** the command SHALL accept a positive integer duration up to and including 24 hours
- **AND** the command SHALL reject zero, negative, non-integer, or greater-than-24-hour durations

## ADDED Requirements

### Requirement: An answered question resumes the blocked asking run

When an asking run reported `blocked` to await its own question, and that question or questionnaire is answered, the engine SHALL re-issue that run for a new attempt so the answer is delivered through the assignment's prior-dialogue context. The engine SHALL re-issue only the asking role, SHALL leave sibling runs of the same step untouched, and SHALL resume only a workflow that is parked on that question: the question's step SHALL be the current step, the asking run SHALL be `blocked` with no active run for its role, and the workflow SHALL be `attention-required`. The resumed attempt SHALL record the answer as untrusted developer-provided context. A question that is cancelled, expired, or forwarded SHALL NOT resume the asking run.

#### Scenario: Answer arrives after the run parked

- **WHEN** a question or questionnaire is answered for an asking run that handed off `blocked` and whose step is the current step
- **THEN** the engine SHALL bump the step attempt and create a new run for the asking role
- **AND** the new run's assignment SHALL include the answer as prior dialogue
- **AND** the workflow SHALL leave `attention-required` unless another run of the workflow is still `blocked`

#### Scenario: Answer arrives while the asking run still works

- **WHEN** a question is answered while the asking run is still `working` or has already completed
- **THEN** the engine SHALL record the answer without re-issuing any run

#### Scenario: Sibling runs are not re-issued

- **WHEN** a question is answered for one role of a step whose other roles have already completed
- **THEN** only the asking role's run SHALL be re-issued
- **AND** the completed sibling runs and their results SHALL remain unchanged

#### Scenario: Cancelled or expired question does not resume

- **WHEN** a pending question is cancelled, expired, or expired by its durable timer
- **THEN** the engine SHALL NOT re-issue the asking run
- **AND** the workflow SHALL remain `attention-required` for explicit developer repair or retry
