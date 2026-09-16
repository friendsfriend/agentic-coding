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

