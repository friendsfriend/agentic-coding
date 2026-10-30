## MODIFIED Requirements

### Requirement: Developer questions from orchestrator-started workflows

A workflow clarification SHALL route first to its explicitly attached appropriate orchestrator conversation, for both orchestrator-started and UI-started workflows. Orchestrator starts SHALL attach to the authenticated calling conversation; workflows without attachment SHALL retain discoverable pending state and a developer-authorized attachment path. Routing SHALL NOT rely solely on immutable start attribution or the currently active session. The orchestrator SHALL answer directly only from agreed task/design or recorded developer decisions, with supporting references and orchestrator attribution. Otherwise it SHALL discuss the question naturally in the existing transcript and SHALL obtain explicit developer confirmation of the exact proposed answer before durable delivery. Ordinary clarification SHALL NOT open a question modal, steal focus or present a special answer form. Existing generic answer/forward operations SHALL NOT bypass session custody, attribution or confirmation requirements. Pending state SHALL remain visible; timeout or an unavailable session SHALL NOT silently answer, discard the decision or reopen a popup. Login/MFA handoffs and human review controls SHALL retain their separate developer-authorized behavior.

#### Scenario: Question routes to the orchestrator first
- **WHEN** a run of an attached workflow creates a clarification
- **THEN** the record SHALL retain its authenticated conversation attachment and appear as a pending clarification for that conversation
- **AND** no developer question modal SHALL open

#### Scenario: Orchestrator discusses with the developer
- **WHEN** the attached orchestrator cannot answer from agreed sources
- **THEN** it SHALL discuss the decision over ordinary transcript turns and present a proposed answer for explicit confirmation before delivery
- **AND** it SHALL NOT forward the question to a popup

#### Scenario: Developer unblocks an idle orchestrator
- **WHEN** the attached orchestrator is unavailable while a clarification remains pending
- **THEN** the developer SHALL be able to inspect the pending state and explicitly attach an appropriate available conversation
- **AND** confirmed answer delivery through that conversation SHALL use the normal asking-run continuation rule

#### Scenario: Orchestrator question cannot be answered by the wrong actor
- **WHEN** an orchestrator attempts to answer a question outside its authenticated conversation custody or with an obsolete attachment epoch
- **THEN** the engine SHALL reject the answer without changing the question

## ADDED Requirements

### Requirement: Durable clarification delivery is separate from advisory monitoring

Clarification delivery SHALL be durable and addressed to the attached conversation rather than the active-session best-effort event monitor. Advisory subscriptions SHALL NOT grant response authority or cause duplicate clarification discussion. Existing monitor off/notify settings SHALL not automatically wake a conversation, and pending clarification SHALL remain discoverable for explicit opening or attachment. Clarification delivery SHALL NOT implicitly create a new conversation or bypass server admission. General event monitoring, review notifications and unrelated recovery permissions SHALL remain unchanged.

#### Scenario: Advisory delivery fails
- **WHEN** a workflow-event note is dropped or the event cursor is replayed
- **THEN** the canonical pending clarification SHALL remain recoverable with the same question identity and stable addressed delivery identity

#### Scenario: Session changes
- **WHEN** a new conversation becomes active while another conversation owns a pending clarification
- **THEN** the new active conversation SHALL NOT receive that question or gain authority to answer it without explicit authorized reattachment
