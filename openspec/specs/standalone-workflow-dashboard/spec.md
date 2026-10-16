# standalone-workflow-dashboard Specification

## Purpose
Defines the restricted surface of `agentic-coding dash`: the dashboard-only presentation root that renders one explicitly targeted workflow through the shared dashboard component, with no application navigation and no competing execution ownership.
## Requirements
### Requirement: Explicit dashboard-only root
`agentic-coding dash` SHALL render the supplied workflow dashboard directly using the shared dashboard implementation, without mounting the full application shell or other feature views. It SHALL expose no navigation tabs, breadcrumbs, Home, Settings, location picker, workflow list, history/reopen surface or global feature commands. Invalid or missing required target identity SHALL produce a bounded error rather than opening a picker.

#### Scenario: Herdr launches dash
- **WHEN** Herdr invokes dash with a valid workflow target
- **THEN** only that workflow dashboard and its required operational dialogs SHALL be available
- **AND** no full-application destinations SHALL be rendered or registered

#### Scenario: Missing identity
- **WHEN** dash lacks a required target or its target cannot be resolved
- **THEN** it SHALL report the error and clean up acquired resources without entering Home

### Requirement: Operational controls without browsing navigation
Dash SHALL retain panel focus/scroll/selection, inline status and agent metrics, contextual help, explicit exit and dialogs necessary for workflow review, questions, credentials, approvals, confirmations and supported revision-bound actions. It SHALL NOT mount or register application navigation: no tabs, breadcrumbs, Home/Settings/environments/wiki/observability pages, location picker, structural-parent shortcut, workflow list, history/reopen surface or global feature commands, by keyboard or by mouse. Required review content SHALL remain available within its operational dialog or the dashboard's own workflow-scoped panel.

#### Scenario: Review requires proposal content
- **WHEN** an active workflow requires a plan review
- **THEN** the review SHALL retain the content and comment/decision controls required to perform that operation without opening an application route

#### Scenario: Removed navigation shortcut
- **WHEN** a user presses a former global feature/picker shortcut or clicks where its old navigation control appeared
- **THEN** dash SHALL NOT navigate or invoke an unadvertised feature handler

#### Scenario: Escape in operational dialog
- **WHEN** Escape dismisses an operational dialog
- **THEN** focus SHALL return to the same dashboard without changing page or losing an unrelated draft

### Requirement: Presentation isolation preserves execution and ownership
Dashboard-only composition SHALL retain authenticated API, revision/capability and existing execution ownership contracts. It SHALL NOT create a competing workflow coordinator. Startup failure and exit SHALL finalize owned client resources once and SHALL NOT stop an attached server or delete workflow data as a presentation side effect.

#### Scenario: Attached dashboard exits
- **WHEN** a dashboard attached to an independently owned server closes
- **THEN** its subscriptions and renderer SHALL close while that server remains running under its existing workflow lifecycle rules

### Requirement: Dashboard dialogs accept the pointer

Every dashboard dialog SHALL accept pointer input under the shared semantics
when it renders a selectable list, an option list, tabs or a footer of key
chips: a tap selects, a tap on the already-selected row performs the dialog's
`Enter` action, and a footer chip runs its argument-free command. Dialogs that
hold typed input, a secret, a running operation or an irreversible action SHALL
NOT be dismissed by a backdrop tap.

#### Scenario: Option list in a dialog

- **WHEN** the developer taps an option row that is not selected in a dashboard dialog
- **THEN** that option SHALL become the selected one
- **AND** tapping it again SHALL perform the dialog's `Enter` action

#### Scenario: Read-only detail dialog

- **WHEN** the developer scrolls a read-only detail dialog with the wheel and taps
- **THEN** the dialog SHALL scroll on the wheel
- **AND** a backwards tap outside the dialog SHALL close it where `Escape` does

#### Scenario: Wizard keeps its draft

- **WHEN** the developer taps outside the new-workflow wizard while a field holds typed text
- **THEN** the wizard SHALL stay open with its draft and step unchanged
- **AND** the field SHALL be reachable by tapping it

#### Scenario: Footer chips in a dialog

- **WHEN** the developer taps a footer chip whose key is available
- **THEN** the same command the key runs SHALL run once

### Requirement: Agent session page accepts the pointer

The agent-session page SHALL accept the pointer: the wheel SHALL scroll the
transcript, a tap on the prompt area SHALL focus the prompt input, block rows
SHALL keep toggling on tap, and the page's picker and filter lists SHALL select
and activate as their keys do.

#### Scenario: Wheel scrolls the transcript

- **WHEN** the developer moves the wheel over the session transcript
- **THEN** the transcript SHALL scroll
- **AND** the prompt input SHALL keep its own content and focus state

#### Scenario: Tapping the prompt focuses it

- **WHEN** the developer taps the prompt area
- **THEN** the prompt input SHALL take text focus as the keyboard path would give it

#### Scenario: Tapping a picker row

- **WHEN** the developer taps a row in the session's picker or filter list
- **THEN** the row SHALL be selected
- **AND** tapping the selected row SHALL perform the picker's `Enter` action

