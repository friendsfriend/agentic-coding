## ADDED Requirements

### Requirement: Login hand-off dialogue records

The server SHALL create one developer dialogue record of `kind: "login-handoff"` for every login hand-off, for the run that owns the session. The record SHALL be created when the hand-off is queued, and its `expiresAt` SHALL be the hand-off deadline. Its description SHALL name the application label, the role and the stage display name. Its context SHALL name the reason, the queue position and the deadline, and SHALL tell the developer to look for the agentic-coding window. It SHALL carry no URL beyond the application's configured origin and no credential. Its options SHALL be **Done** and **Abort**.

The record SHALL count as a pending developer question for notifications, for the workflow view and for the `question.pending` event. The event payload SHALL identify `kind: "login-handoff"`. The record SHALL never carry the orchestrator routing marker, even in an orchestrator-started workflow, and an orchestrator answer to it SHALL be rejected. The dashboard modal SHALL show it without a custom text answer, and Escape SHALL choose Abort.

The server SHALL resolve the record itself when the hand-off ends without a developer answer. That covers success, timeout, the window being closed, the run ending, or the agent closing the session. Neither a system resolution nor a developer answer to this record SHALL resume a blocked asking run. The record SHALL be excluded from the prior-dialogue text of later assignments.

#### Scenario: Hand-off raises the developer's attention

- **WHEN** a hand-off is queued for a run
- **THEN** the workflow SHALL show one pending `login-handoff` record, the dashboard question modal SHALL offer Done and Abort without a custom answer, and the `question.pending` event SHALL carry `kind: "login-handoff"`

#### Scenario: Orchestrator-started workflow

- **WHEN** a hand-off is queued in a workflow started by the orchestrator
- **THEN** the record SHALL NOT carry the orchestrator routing marker, and SHALL appear in the developer's pending questions

#### Scenario: Orchestrator cannot answer

- **WHEN** the orchestrator attempts to answer a `login-handoff` record
- **THEN** the engine SHALL reject the answer without changing the record

#### Scenario: Success resolves the record

- **WHEN** the server detects that the login succeeded while the record is pending
- **THEN** the record SHALL be resolved by the system, and no run SHALL be resumed by that resolution

#### Scenario: Deadline expires the record

- **WHEN** the hand-off deadline passes, including after a server restart that lost the hand-off
- **THEN** the record SHALL expire through the existing question timer
