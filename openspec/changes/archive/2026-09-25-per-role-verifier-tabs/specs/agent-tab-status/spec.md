## MODIFIED Requirements

### Requirement: Tab label shows the current run status per role
Every workflow-managed agent tab SHALL carry exactly one leading status glyph before its role or group name. For each role present on a tab, only that role's latest run SHALL determine the role's displayed status; superseded runs from an earlier attempt, generation, or round SHALL NOT influence the label. Because each verifier role owns its own tab, a verifier tab SHALL show only that role's latest status. When several roles do share one tab, the glyph SHALL be the aggregate of the latest-per-role statuses ordered by urgency, with outstanding work ahead of terminal states.

#### Scenario: Superseded failed run does not pin the glyph

- **WHEN** a role's earlier run is `failed` or `blocked` and that role's latest run is `completed`
- **THEN** the tab SHALL show the completed glyph (`✓`)
- **AND** the superseded `failed`/`blocked` status SHALL NOT keep the tab on `✗`/`■`

#### Scenario: Reactivated role shows working again

- **WHEN** a role's latest run is `working` after an earlier run on the same tab was `completed`, `failed`, or `blocked`
- **THEN** the tab SHALL show the working glyph (`●`)

#### Scenario: Per-role verifier tab shows only that role
- **WHEN** each verifier role occupies its own tab and several verifier roles are working in the same round
- **THEN** each role's tab SHALL show only that role's latest run status
- **AND** one role's status SHALL NOT change another role's tab glyph

#### Scenario: Grouped tab aggregates the latest run per role

- **WHEN** a tab is genuinely shared by several roles
- **THEN** each role SHALL contribute only its latest run's status to the aggregation
- **AND** the displayed glyph SHALL be the most urgent of those latest-per-role statuses
