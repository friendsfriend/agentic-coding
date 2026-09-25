# workflow-developer-notifications Specification

## Purpose
Alerts the developer through Herdr whenever a workflow needs a developer decision or input and takes them to that workflow's dashboard, without changing workflow state.

## Requirements

### Requirement: Developer-action notification

The system SHALL raise one Herdr notification when a governed workflow transitions from not owing developer input to owing it. A workflow owes developer input when its committed status is `paused` or `attention-required`, when at least one of its available actions declares `requiresInput`, or when at least one associated run has an unexpired pending developer question or a fresh-or-retained `blocked` runtime observation. The notification title SHALL carry the workflow id and the notification body SHALL carry the current phase label. The notification SHALL request the needs-attention sound class.

#### Scenario: Approval gate opens
- **WHEN** a workflow enters a registered plan, developer-review, or wiki approval step and had no developer obligation in the previous observation
- **THEN** the system SHALL raise exactly one Herdr notification naming the workflow and the phase

#### Scenario: Agent asks a developer question
- **WHEN** an associated run acquires an unexpired pending developer question and had no developer obligation in the previous observation
- **THEN** the system SHALL raise exactly one Herdr notification naming the workflow and the phase

#### Scenario: Agent runtime blocks on input
- **WHEN** an associated run is freshly observed `blocked`, or a retained positive blocked observation cannot be refreshed, and the workflow had no developer obligation in the previous observation
- **THEN** the system SHALL raise exactly one Herdr notification naming the workflow and the phase

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

### Requirement: Dashboard focus on notification

When the system raises a developer-action notification for a workflow with a workspace, it SHALL focus the workspace and its workflow dashboard tab as a bounded best-effort step. A workflow without a live workspace or without a dashboard tab SHALL still receive the notification and SHALL NOT surface a focus failure as a workflow failure.

#### Scenario: Notification focuses the workflow dashboard
- **WHEN** the notifier raises a notification for a workflow whose workspace contains a tab whose base label is `dashboard`
- **THEN** it SHALL focus that workspace and that dashboard tab

#### Scenario: Dashboard tab is unavailable
- **WHEN** the notifier raises a notification for a workflow with no workspace or no resolvable dashboard tab
- **THEN** the notification SHALL still be raised
- **AND** the missing focus target SHALL be reported at most as a bounded diagnostic

### Requirement: Opt-in trusted preference

The integration SHALL be controlled only by the trusted user preference `ui.herdr_notifications`, defaulting to disabled. Project configuration SHALL NOT enable the integration for other workspaces. While disabled, the system SHALL NOT observe workflow views or agent state for notification and SHALL NOT raise notifications. While enabled, the notifier SHALL run only as long as at least one Agentic Coding shell is alive; no notification daemon SHALL outlive the last shell.

#### Scenario: Preference absent or false
- **WHEN** the trusted user configuration does not set `ui.herdr_notifications` to true
- **THEN** the system SHALL NOT raise developer-action notifications

#### Scenario: Project configuration tries to enable it
- **WHEN** a repository project configuration sets the notification preference and the trusted user configuration does not
- **THEN** the system SHALL remain disabled

#### Scenario: Last shell exits
- **WHEN** the last Agentic Coding shell that enabled the notifier exits
- **THEN** notification observation SHALL stop and no background process SHALL remain

### Requirement: Presentation-only notification side effects

Raising a notification, focusing a dashboard, reading observations, or failing any of those SHALL NOT change a workflow revision, available action, run status, capability, durable effect attempt, or agent process. Notification and focus failures SHALL be bounded diagnostics that do not propagate to the workflow engine.

#### Scenario: Herdr is unavailable
- **WHEN** a notification or focus call fails because Herdr is unavailable
- **THEN** the workflow SHALL continue unchanged
- **AND** the failure SHALL be reported at most once per distinct bounded message

#### Scenario: Notification delivery is refused
- **WHEN** Herdr reports the notification as disabled, rate-limited, busy, or without a foreground client
- **THEN** the workflow SHALL continue unchanged
- **AND** the notifier SHALL treat the obligation as raised rather than retrying it in a tight loop

### Requirement: Documented default-notification suppression

The system documentation SHALL describe how to silence Herdr's default agent-finished notifications through Herdr configuration, and SHALL state that on Herdr 0.9.1 the toast delivery setting is global, so muting all toasts also mutes developer-action notifications, while exact finished-only muting and notification click-to-focus require upstream Herdr capabilities.

#### Scenario: Operator reads the setup guidance
- **WHEN** an operator enables `ui.herdr_notifications`
- **THEN** the documentation SHALL state the Herdr `[ui.sound]` and `[ui.toast]` settings that affect agent-finished alerts
- **AND** it SHALL name the upstream capabilities required for finished-only muting and click-to-focus
