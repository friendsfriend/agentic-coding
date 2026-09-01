## MODIFIED Requirements

### Requirement: Authenticated developer question interface
Every active managed agent SHALL be able to submit a bounded developer question containing a description and zero or more recommended options, or an ordered bounded questionnaire containing multiple related questions. Existing single-question payloads SHALL remain supported. Each questionnaire item SHALL have its own description, optional context, and options, and the questionnaire SHALL have a bounded item count and preserve item order. The interface SHALL authenticate the request against the active run capability and SHALL not allow an agent to identify another run or workflow. A question or questionnaire created without a shorter explicit wait SHALL remain pending for up to 24 hours before automatic expiry, and an explicit CLI wait SHALL be accepted only when it is a positive duration no greater than 24 hours.

#### Scenario: Agent asks with recommended options
- **WHEN** an active managed agent invokes `developer_question` with a non-empty description and recommended options
- **THEN** the workflow SHALL durably enqueue the question with its workflow, run, step, and role identity
- **AND** the invocation SHALL wait for the corresponding developer response
- **AND** selecting a recommended option SHALL return that option's value to the requesting agent

#### Scenario: Agent asks a bounded questionnaire
- **WHEN** an active managed agent invokes `developer_question` with an ordered list of related question items
- **THEN** the workflow SHALL durably enqueue the items as one questionnaire with stable item identity and creation order
- **AND** the invocation SHALL wait until every item has a response or the questionnaire is cancelled or expires
- **AND** the result SHALL contain one structured response per item in the original order
- **AND** answering one item SHALL not overwrite, resolve, or discard another item

#### Scenario: Developer supplies a custom response
- **WHEN** the developer chooses the custom-response path for a question or questionnaire item and submits non-empty text
- **THEN** the pending item SHALL be answered with that text, including newlines and structured formatting
- **AND** the requesting agent SHALL receive the exact custom text in the corresponding tool result

#### Scenario: Question request is invalid or unauthorized
- **WHEN** a request has an invalid description, context, options, questionnaire item count, or answer payload, an expired or wrong run capability, or no active run
- **THEN** the workflow SHALL reject it without creating a question or changing workflow lifecycle state
- **AND** the diagnostic SHALL not disclose another workflow's state or capability

#### Scenario: No interactive developer channel is available
- **WHEN** a question or questionnaire is requested while no dashboard can answer it before the bounded wait expires
- **THEN** the interface SHALL return a bounded error or cancellation result no later than 24 hours after creation, unless a shorter explicit CLI timeout is reached first
- **AND** the managed agent process SHALL not remain blocked indefinitely

#### Scenario: Default question expiry is 24 hours
- **WHEN** an authenticated managed agent creates a question or questionnaire without an explicit shorter CLI timeout
- **THEN** the durable question records SHALL have an expiry timestamp 24 hours after creation
- **AND** the records SHALL remain pending before that timestamp when no developer response has been received

#### Scenario: Timeout override is bounded by 24 hours
- **WHEN** an authenticated managed agent invokes the CLI question command with `--timeout`
- **THEN** the command SHALL accept a positive integer duration up to and including 24 hours
- **AND** the command SHALL reject zero, negative, non-integer, or greater-than-24-hour durations

### Requirement: Dashboard question modal
The dash SHALL surface pending developer questions in a modal independently of the current workflow phase or busy effect drain. A grouped questionnaire SHALL be presented as a tabbed sequence of its question items, while independently queued single-question requests SHALL retain stable FIFO presentation. Each tab SHALL display its question description, requester identity, optional context, response state, and recommended options, and the modal SHALL always offer a custom text response.

#### Scenario: Pending question opens
- **WHEN** a valid question or questionnaire is pending for a workflow shown by the dash
- **THEN** the dash SHALL show the oldest unanswered request with its requesting role
- **AND** a questionnaire SHALL show one tab per question in creation order with a visible current-tab indicator
- **AND** normal dashboard content SHALL remain behind the modal

#### Scenario: Questionnaire tabs preserve progress
- **WHEN** the developer navigates between questionnaire tabs
- **THEN** the modal SHALL preserve each tab's selected option or custom-text draft without submitting it to another question
- **AND** the tab state SHALL visibly distinguish unanswered, answered, and currently selected items
- **AND** navigation SHALL not change the order or identity of the questions

#### Scenario: Recommended option is selected
- **WHEN** the developer confirms a recommended option for the displayed question
- **THEN** the dash SHALL record that option for the exact question item
- **AND** the modal SHALL advance or allow navigation to another unanswered tab without answering any other item
- **AND** a grouped request SHALL be submitted only after every item has a valid response

#### Scenario: Custom response is submitted
- **WHEN** the developer enters non-empty multiline custom text for the displayed question and confirms it
- **THEN** the dash SHALL retain the exact text, including newlines and structured formatting, for that question item
- **AND** the requesting tool SHALL receive the same text without dashboard-only formatting
- **AND** the modal SHALL not submit an empty or whitespace-only custom response

#### Scenario: Questionnaire is submitted
- **WHEN** every question item in a questionnaire has a recommended-option or non-empty custom response and the developer confirms submission
- **THEN** the dash SHALL submit all item responses as one response set for the exact questionnaire and current workflow revision
- **AND** the modal SHALL close or advance only after the engine accepts the response set

#### Scenario: Question is cancelled
- **WHEN** the developer presses Escape or otherwise cancels the displayed question or questionnaire
- **THEN** the pending request SHALL be resolved as cancelled
- **AND** a grouped request SHALL report cancellation without silently treating unanswered items as answers
- **AND** the requesting agent SHALL receive a cancellation result rather than waiting forever

#### Scenario: Concurrent questions are queued
- **WHEN** multiple active agents ask questions before the developer answers them
- **THEN** the dash SHALL present independently queued requests one at a time in stable creation order
- **AND** answering one request SHALL not answer, overwrite, or discard another request

### Requirement: Shared developer dialogue
The workflow SHALL retain a bounded, ordered dialogue record for each question and response, including requester role and step identity, and SHALL expose the record through the validated workflow view and future managed-agent assignments. A questionnaire SHALL retain the ordered item records and their response state as one related request, and dialogue content SHALL be marked as developer-provided context and treated as untrusted text by agents.

#### Scenario: Later agent receives prior decision
- **WHEN** a question or questionnaire has been answered and a later planner, worker, or verifier assignment is rendered for the same workflow
- **THEN** the assignment SHALL include the available prior question and answer history
- **AND** grouped history SHALL preserve questionnaire and item order, response kind, and exact custom text
- **AND** the history SHALL include security-verifier assignments when they are launched later

#### Scenario: Dialogue survives workflow refresh
- **WHEN** the dash or an agent reloads the workflow after a question or questionnaire is answered
- **THEN** the same ordered dialogue records and grouped response state SHALL remain available from canonical workflow state
- **AND** runtime observations or pane status SHALL not be the source of truth for the record

#### Scenario: Dialogue bounds are reached
- **WHEN** a new question, questionnaire item, or answer would exceed the workflow's configured count or content bounds
- **THEN** the request SHALL fail with an actionable bounded diagnostic
- **AND** existing dialogue history SHALL remain unchanged

## ADDED Requirements

### Requirement: Agent-facing question authoring guidance
The `developer_question` tool schema and description SHALL explain that agents must ask only when a material decision is unclear, state the decision needed in a concise question, provide actionable and mutually distinguishable option labels and values when choices are known, include relevant context without secrets or unrelated history, and use a questionnaire only for related decisions that the developer can answer together. The guidance SHALL explain that custom responses support structured multiline text and that the returned response must be treated as developer-provided, untrusted input.

#### Scenario: Agent sees actionable tool guidance
- **WHEN** an agent discovers the `developer_question` tool
- **THEN** its description SHALL identify the decision, option, context, questionnaire, and custom-response expectations
- **AND** the parameter descriptions SHALL identify bounds and the structured per-question result
- **AND** the guidance SHALL not imply that the tool is a general conversational chat channel

#### Scenario: Questionnaire guidance prevents unrelated batching
- **WHEN** an agent is deciding whether to send multiple questions in one request
- **THEN** the tool guidance SHALL direct it to batch only questions sharing the same decision context and response moment
- **AND** unrelated or independently timed decisions SHALL remain separate requests
