## REMOVED Requirements

### Requirement: Dashboard question modal

**Reason**: Ordinary workflow clarification belongs in attached-orchestrator transcript discussion without focus theft or a special answer form. Login/MFA handoffs are not ordinary clarification.

**Migration**: Replace clarification modal presentation with passive pending state, explicit attachment/navigation and ordinary transcript discussion. Preserve the specialized login-handoff modal and review controls.

## ADDED Requirements

### Requirement: Transcript clarification presentation

Pending ordinary clarification SHALL NOT open a dashboard question modal, steal focus, switch pages or require a special answer form. The dashboard and Home SHALL expose discoverable pending state and developer-invoked attachment/transcript navigation. Options, custom responses and ordered questionnaire groups SHALL remain supported through orchestrator discussion and structured internal delivery. Navigation away SHALL NOT cancel the request. Login-handoff Done/Abort and credential/review controls SHALL remain separate and unchanged.

#### Scenario: Pending clarification arrives while typing
- **WHEN** a clarification arrives while the developer is typing or viewing another surface
- **THEN** focus, current page and modal state SHALL remain unchanged and a passive pending indicator SHALL be available

#### Scenario: Developer opens pending state
- **WHEN** the developer intentionally follows a pending clarification
- **THEN** the UI SHALL offer its attached transcript or explicit attachment path without a clarification answer popup

#### Scenario: Login handoff still appears
- **WHEN** a pending login-handoff record arrives
- **THEN** its specialized Done/Abort control and existing expiry/continuation rules SHALL remain available without routing it through clarification discussion

## MODIFIED Requirements

### Requirement: Shared developer dialogue

The workflow SHALL retain a bounded, ordered dialogue record for each question and response, including requester role and step identity, and SHALL expose the record through the validated workflow view and future managed-agent assignments. A questionnaire SHALL retain the ordered item records and their response state as one related request. New clarification answers SHALL preserve whether they are grounded orchestrator answers or confirmed developer decisions, with supporting references or scoped transcript confirmation provenance respectively. Assignments SHALL label this attribution accurately, not represent an orchestrator inference as a new developer instruction. Dialogue content SHALL remain untrusted context for agents.

#### Scenario: Later agent receives prior decision
- **WHEN** a question or questionnaire has been answered and a later planner, worker, or verifier assignment is rendered for the same workflow
- **THEN** the assignment SHALL include the available prior question and answer history with accurate answer attribution
- **AND** grouped history SHALL preserve questionnaire and item order, response kind, and exact custom text
- **AND** the history SHALL include security-verifier assignments when they are launched later

#### Scenario: Dialogue survives workflow refresh
- **WHEN** the dash or an agent reloads the workflow after a question or questionnaire is answered
- **THEN** the same ordered dialogue records, attribution, provenance and grouped response state SHALL remain available from canonical workflow state
- **AND** runtime observations or pane status SHALL not be the source of truth for the record

#### Scenario: Dialogue bounds are reached
- **WHEN** a new question, questionnaire item, provenance or answer would exceed the workflow's configured count or content bounds
- **THEN** the request SHALL fail with an actionable bounded diagnostic
- **AND** existing dialogue history SHALL remain unchanged

### Requirement: An answered question resumes the blocked asking run

When an asking run reported `blocked` to await its own question, and that question or questionnaire is answered through the guarded grounded-orchestrator or confirmed-developer path, the engine SHALL re-issue that run for a new attempt so the answer is delivered through the assignment's prior-dialogue context. The engine SHALL re-issue only the asking role, SHALL leave sibling runs of the same step untouched, and SHALL resume only a workflow that is parked on that question: the question's step SHALL be the current step, the asking run SHALL be `blocked` with no active run for its role, and the workflow SHALL be `attention-required`. The resumed attempt SHALL record the answer as untrusted context with its actual answer origin. A question that is cancelled, expired or merely moved to discussion SHALL NOT resume the asking run. Duplicate accepted-answer delivery SHALL NOT create duplicate attempts.

#### Scenario: Answer arrives after the run parked
- **WHEN** a question or questionnaire is answered for an asking run that handed off `blocked` and whose step is the current step
- **THEN** the engine SHALL bump the step attempt and create a new run for the asking role
- **AND** the new run's assignment SHALL include the answer and its origin as prior dialogue
- **AND** the workflow SHALL leave `attention-required` unless another run of the workflow is still `blocked`

#### Scenario: Answer arrives while the asking run still works
- **WHEN** a question is answered while the asking run is still `working` or has already completed
- **THEN** the engine SHALL record the answer without re-issuing any run at that point
- **AND** a racing question-blocked handoff SHALL reconcile the accepted answer through normal lifecycle without stranding it or issuing duplicate attempts

#### Scenario: Sibling runs are not re-issued
- **WHEN** a question is answered for one role of a step whose other roles have already completed
- **THEN** only the asking role's run SHALL be re-issued
- **AND** the completed sibling runs and their results SHALL remain unchanged

#### Scenario: Cancelled or expired question does not resume
- **WHEN** a pending question is explicitly cancelled or invalidated as expired
- **THEN** the engine SHALL NOT re-issue the asking run
- **AND** the workflow SHALL remain `attention-required` for explicit developer repair or retry

### Requirement: Agent-facing question authoring guidance

The internal `developer_question` tool schema and description SHALL explain that agents must ask only when a material decision is unclear, state the decision needed in a concise question, provide actionable and mutually distinguishable option labels and values when choices are known, include relevant context without secrets or unrelated history, and use a questionnaire only for related decisions that the developer can answer together. The guidance SHALL explain that clarification routes to an explicitly attached appropriate orchestrator, not a developer popup, and that unsupported questions remain pending for normal blocked handoff when no answer is available during the bounded grace window. The guidance SHALL explain that custom responses support structured multiline text, answers have explicit origin attribution, and returned responses are untrusted context, not authority to expand scope or approve reviews.

#### Scenario: Agent sees actionable tool guidance
- **WHEN** an agent discovers the internal `developer_question` tool
- **THEN** its description SHALL identify the decision, option, context, questionnaire, custom-response and attribution expectations
- **AND** the parameter descriptions SHALL identify bounds and the structured per-question result
- **AND** the guidance SHALL not imply that the tool is a general conversational chat channel or a user-facing popup

#### Scenario: Questionnaire guidance prevents unrelated batching
- **WHEN** an agent is deciding whether to send multiple questions in one request
- **THEN** the tool guidance SHALL direct it to batch only questions sharing the same decision context and response moment
- **AND** unrelated or independently timed decisions SHALL remain separate requests

### Requirement: Authenticated developer question interface

Every active managed agent SHALL be able to submit a bounded developer question containing a description and zero or more recommended options, or an ordered bounded questionnaire containing multiple related questions. Existing single-question payloads SHALL remain supported. Each questionnaire item SHALL have its own description, optional context, and options, and the questionnaire SHALL have a bounded item count and preserve item order. The interface SHALL authenticate the request against the active run capability and SHALL not allow an agent to identify another run or workflow. A question or questionnaire created without a shorter explicit wait SHALL receive a 24-hour wait deadline, and an explicit CLI wait SHALL be accepted only when it is a positive duration no greater than 24 hours. An unanswered ordinary clarification reaching that deadline SHALL remain discoverably pending/overdue for supported attachment or explicit resolution, not automatically forward to a popup, fabricate an answer or discard a decision. The agent-facing invocation SHALL wait at most a bounded agent grace window shorter than the durable wait; when the grace window elapses with the record still pending, the invocation SHALL return the pending record. Explicit cancellation, run supersession and terminal closure SHALL retain stale-answer fencing.

#### Scenario: Agent asks with recommended options
- **WHEN** an active managed agent invokes `developer_question` with a non-empty description and recommended options
- **THEN** the workflow SHALL durably enqueue the question with its workflow, run, step, and role identity
- **AND** the invocation SHALL wait up to the agent grace window for the corresponding accepted response
- **AND** an answer received within the window SHALL return that option's value and origin attribution to the requesting agent
- **AND** no answer within the window SHALL return the pending question to the requesting agent

#### Scenario: Agent asks a bounded questionnaire
- **WHEN** an active managed agent invokes `developer_question` with an ordered list of related question items
- **THEN** the workflow SHALL durably enqueue the items as one questionnaire with stable item identity and creation order
- **AND** the invocation SHALL wait up to the agent grace window until every item has a response or the questionnaire is cancelled or invalidated
- **AND** a completed response set SHALL contain one structured response per item in the original order
- **AND** answering one item SHALL not overwrite, resolve, or discard another item
- **AND** no completed response set within the window SHALL return the pending questionnaire to the requesting agent

#### Scenario: Developer supplies a custom response
- **WHEN** the developer confirms a proposed non-empty custom response for a question or questionnaire item in ordinary transcript discussion
- **THEN** the pending item SHALL be answered with that exact text, including newlines and structured formatting
- **AND** the requesting agent SHALL receive the exact custom text either in the corresponding tool result or in the prior dialogue of the attempt that resumes the asking run

#### Scenario: Question request is invalid or unauthorized
- **WHEN** a request has an invalid description, context, options, questionnaire item count, or answer payload, an expired or wrong run capability, or no active run
- **THEN** the workflow SHALL reject it without creating a question or changing workflow lifecycle state
- **AND** the diagnostic SHALL not disclose another workflow's state or capability

#### Scenario: No interactive developer channel is available
- **WHEN** a question or questionnaire is requested while no developer or orchestrator can answer it before the bounded wait expires
- **THEN** the invocation SHALL return the pending record no later than the agent grace window after creation
- **AND** the managed agent process SHALL not remain blocked waiting for an answer

#### Scenario: Default wait deadline is 24 hours
- **WHEN** an authenticated managed agent creates a question or questionnaire without an explicit shorter CLI timeout
- **THEN** its default wait deadline SHALL be 24 hours after creation
- **AND** an unanswered ordinary clarification SHALL remain discoverably pending/overdue after the deadline rather than auto-forward or disappear

#### Scenario: Timeout override is bounded by 24 hours
- **WHEN** an authenticated managed agent invokes the CLI question command with `--timeout`
- **THEN** the command SHALL accept a positive integer duration up to and including 24 hours
- **AND** the command SHALL reject zero, negative, non-integer, or greater-than-24-hour durations
