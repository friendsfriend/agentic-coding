# orchestrator-transcript-clarifications Specification

## Purpose
TBD - created by archiving change orchestrator-transcript-clarifications. Update Purpose after archive.
## Requirements
### Requirement: Explicit appropriate-session attachment

Every workflow clarification SHALL be associated with an explicitly attached appropriate orchestrator conversation or remain discoverably unassigned. Orchestrator starts SHALL attach to the authenticated calling conversation; UI starts SHALL support explicit attachment to a known conversation or leaving the workflow unassigned. Developer-authorized attachment and reattachment SHALL be supported from workflow UI and ordinary transcript interaction. Attachment SHALL NOT change start attribution, review or recovery authority. Session identity SHALL be authenticated by the server, not trusted from request fields; shared instance credentials and observation/subscription access alone SHALL NOT authorize another session's clarification actions.

#### Scenario: UI-started workflow
- **WHEN** a developer starts a workflow from the UI and chooses an appropriate orchestrator
- **THEN** its clarification custody SHALL persist that conversation and attachment epoch while start attribution remains developer

#### Scenario: No available orchestrator
- **WHEN** a workflow has a pending question without an attached available orchestrator
- **THEN** its question identity and unavailable/unassigned status SHALL remain discoverable with a supported explicit attachment path and no popup

#### Scenario: Different conversation attempts a reply
- **WHEN** another session attempts to answer, confirm or deliver a question using the shared instance capability or a claimed session id
- **THEN** the server SHALL refuse without widening authority or changing dialogue

#### Scenario: New session or reattachment
- **WHEN** the developer starts a new conversation or explicitly reattaches a workflow
- **THEN** a new conversation SHALL NOT inherit custody implicitly and reattachment SHALL invalidate old delivery claims and candidate confirmations without deleting history

### Requirement: Grounded direct orchestrator answers

An attached orchestrator SHALL answer directly only when supported by agreed task/design or recorded developer decisions, without requesting a new developer response. The accepted answer SHALL include bounded supporting references and rationale and SHALL be attributed as an orchestrator-grounded answer. Unsupported scope or design choices SHALL enter discussion instead. Internal answer operations SHALL check custody, question identity, current revision and asking-run validity; no generic legacy action SHALL bypass these checks.

#### Scenario: Existing design settles a question
- **WHEN** the attached orchestrator finds an agreed design decision answering a pending clarification
- **THEN** it SHALL intentionally relay a structured grounded answer with supporting references without popup, focus change or confirmation interruption

#### Scenario: Unsupported preference
- **WHEN** the agreed sources do not settle the question
- **THEN** the orchestrator SHALL discuss it with the developer rather than invent a direct answer

### Requirement: Confirmed ordinary transcript discussion

The orchestrator SHALL discuss unsettled clarification naturally over ordinary transcript turns. Before relaying a developer-derived decision it SHALL stage and present the exact proposed structured answer for the identified question/group and obtain explicit developer confirmation of that candidate version. Confirmation SHALL reference a real subsequent developer message in the same authenticated conversation and the presented candidate; a model assertion of developer identity SHALL NOT suffice. No passive user-message listener SHALL answer a question. Partial/ambiguous replies, unrelated chat and edits SHALL NOT deliver an answer; changed candidates SHALL require fresh confirmation. There SHALL be no user-facing question tool, special answer form or required machine-readable answer syntax.

#### Scenario: Discussion then confirmation
- **WHEN** a developer discusses alternatives across multiple turns and explicitly confirms the orchestrator's presented answer
- **THEN** the exact confirmed response set and transcript provenance SHALL be durably relayed once

#### Scenario: Unrelated or ambiguous message
- **WHEN** a user posts unrelated text, gives a partial answer or says yes with multiple unresolved proposals
- **THEN** no question SHALL automatically become answered and the orchestrator SHALL clarify the intended decision before relay

#### Scenario: Candidate changes
- **WHEN** a proposed answer is edited after confirmation or reattachment invalidates its epoch
- **THEN** the previous confirmation SHALL NOT authorize the changed candidate

#### Scenario: Options custom values and groups
- **WHEN** discussion resolves a questionnaire with both option choices and multiline custom text
- **THEN** each item SHALL retain its stable identity and exact value in original order and delivery SHALL require confirmation of the complete set without altering other requests

### Requirement: Durable addressed clarification delivery

Canonical bounded state SHALL persist question/group and requester identity, attachment, discussion/candidate identity, answer origin, transcript/source provenance and delivery status. Clarification delivery SHALL target the pinned conversation with stable idempotency identity and durable acknowledgement, independent of best-effort advisory event subscriptions. Reconnect, replay, restart and acknowledgement loss SHALL NOT lose pending decisions or duplicate delivered prompts. Monitor off/notify SHALL not automatically wake a session; pending questions SHALL remain discoverable and reconcile on explicit opening or attachment. Clarification wait expiry SHALL NOT reopen a popup, silently invent an answer or discard a decision; explicit cancellation, supersession and terminal closure SHALL invalidate stale authority while preserving history. Login expiry SHALL retain its separate behavior.

#### Scenario: Acceptance precedes receipt crash
- **WHEN** a host accepts question delivery and the process restarts before acknowledgement persistence
- **THEN** reconciliation SHALL replay the same delivery identity and the pinned conversation SHALL receive no duplicate prompt

#### Scenario: Delivery unavailable
- **WHEN** the pinned host is unavailable or automatic wake is disabled
- **THEN** the pending question SHALL remain visible and recoverable without starting a replacement conversation, stealing focus or bypassing admission

#### Scenario: Legacy store reopens
- **WHEN** a schema7 store contains pending clarification records without attachment
- **THEN** those records SHALL decode as discoverably unassigned and support explicit attachment without fabricated provenance or destructive migration

### Requirement: Exactly-once accepted-answer lifecycle

Accepted-answer provenance and lifecycle consequences SHALL commit atomically under workflow revision, question/group, custody epoch and asking-run fences. Identical retries SHALL return the accepted receipt without another resume; conflicting, cancelled, expired or superseded answers SHALL be refused without modifying history. Continuation SHALL use normal lifecycle/outbox mechanisms, preserve sibling runs and launch/ownership/generation fencing, and SHALL NOT directly launch workers from transcript tools.

#### Scenario: Blocked asker resumes
- **WHEN** a valid answer reaches a current blocked asking role with no active replacement
- **THEN** the normal lifecycle SHALL issue exactly one replacement attempt with attributable prior dialogue and leave sibling runs untouched

#### Scenario: Answer races blocked handoff
- **WHEN** an answer is accepted while the asker still works and its pending-question blocked handoff races acceptance
- **THEN** normal reconciliation SHALL deliver the answer without stranding the workflow or creating duplicate attempts

#### Scenario: Stale answer or duplicate relay
- **WHEN** duplicate delivery, cancellation, run supersession or another accepted answer races a relay
- **THEN** at most one answer and eligible continuation SHALL commit and stale mutations SHALL not rewrite history

### Requirement: Clarification is not approval

Attachment, transcript discussion and confirmation SHALL grant no authority to approve/reject plan, developer, findings or wiki reviews, complete login/MFA, alter configuration or bypass admission. All clarification content SHALL remain bounded untrusted context, with content-free operational telemetry and existing secret protection.

#### Scenario: Attempted review or login substitution
- **WHEN** a clarification reply asks to approve a review or complete a login handoff
- **THEN** it SHALL NOT resolve those controls and their existing developer-authorized paths SHALL remain required

