# Spec Delta

## MODIFIED Requirements

### Requirement: Developer-action notification

The system SHALL raise one notification through the selected multiplexer when a governed workflow transitions from not owing developer input to owing it. A workflow owes developer input when its committed status is `paused` or `attention-required`, when at least one of its available actions declares `requiresInput`, or when at least one associated run has an unexpired pending developer question or a fresh-or-retained `blocked` runtime observation. The notification title SHALL carry the workflow id and the notification body SHALL carry the current phase label. The notification SHALL request the needs-attention presentation class.

#### Scenario: Approval gate opens
- **WHEN** a workflow enters a registered plan, developer-review, or wiki approval step and had no developer obligation in the previous observation
- **THEN** the system SHALL raise exactly one notification naming the workflow and the phase

#### Scenario: Agent asks a developer question
- **WHEN** an associated run acquires an unexpired pending developer question and had no developer obligation in the previous observation
- **THEN** the system SHALL raise exactly one notification naming the workflow and the phase

#### Scenario: Agent runtime blocks on input
- **WHEN** an associated run is freshly observed `blocked`, or a retained positive blocked observation cannot be refreshed, and the workflow had no developer obligation in the previous observation
- **THEN** the system SHALL raise exactly one notification naming the workflow and the phase

#### Scenario: Workflow already owes input at first observation
- **WHEN** the notifier observes a workflow that already owes developer input and has no recorded prior observation for it
- **THEN** it SHALL NOT raise a notification for that first observation
- **AND** it SHALL record the obligation so the next obligation transition can notify

#### Scenario: Obligation clears and returns
- **WHEN** a workflow stops owing developer input and later owes it again
- **THEN** the system SHALL raise one new notification for the new obligation

#### Scenario: Repeated refresh while still owed
- **WHEN** the notifier refreshes repeatedly while a workflow continues to owe developer input
- **THEN** it SHALL NOT raise an additional notification for the same obligation

### Requirement: Presentation-only notification side effects

Raising a notification, focusing a dashboard, reading observations, or failing any of those SHALL NOT change a workflow revision, available action, run status, capability, durable effect attempt, or agent process. Notification and focus failures SHALL be bounded diagnostics that do not propagate to the workflow engine.

#### Scenario: Herdr is unavailable
- **WHEN** a notification or focus call fails because the selected multiplexer runtime (Herdr by default, or the configured runtime) is unavailable
- **THEN** the workflow SHALL continue unchanged
- **AND** the failure SHALL be reported at most once per distinct bounded message

#### Scenario: Notification delivery is refused
- **WHEN** the selected multiplexer reports the notification as disabled, rate-limited, busy, unauthorized, or without a foreground client
- **THEN** the workflow SHALL continue unchanged
- **AND** the notifier SHALL treat the obligation as raised rather than retrying it in a tight loop
