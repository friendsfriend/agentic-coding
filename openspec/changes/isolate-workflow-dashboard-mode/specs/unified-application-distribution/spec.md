## MODIFIED Requirements

### Requirement: Compatible command modes
The executable SHALL preserve workflow verbs and explicit workflow target identity, provide default unified TUI, server and attach modes, and support a thin devenv command alias. Default, home and manager full-application entry SHALL open Home. Dash SHALL select a dashboard-only presentation mode rather than an initial route inside the full feature shell. Removed phase-specific workflow verbs SHALL NOT be reintroduced.

#### Scenario: Per-workflow dashboard alias
- **WHEN** `agentic-coding dash` is invoked with an existing repository/workflow identity
- **THEN** it SHALL open only that workflow through the shared dashboard component without full-application navigation or a duplicate dashboard implementation

#### Scenario: Full application aliases
- **WHEN** the executable starts in default, home or manager full-application mode
- **THEN** it SHALL open Home with Environments, Observability, Wiki and Settings rather than a workflow list

#### Scenario: Attach during mixed-runtime milestone
- **WHEN** a client attaches to an environment-only backend
- **THEN** supported environment features SHALL work and unavailable remote workflow capabilities SHALL be identified explicitly
- **AND** local workflow data SHALL NOT be mislabeled as data from the attached server
