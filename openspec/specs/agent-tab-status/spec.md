# agent-tab-status Specification

## Purpose
Keeps every workflow-managed Herdr agent tab's name showing that agent's current run status as a single leading glyph, so tab progress is visible without widening the tab and without an agent that finished and later resumed getting stuck on a stale status.

## Requirements

### Requirement: Tab label shows the current run status per role

Every workflow-managed agent tab SHALL carry exactly one leading status glyph before its role or group name. For each role present on a tab, only that role's latest run SHALL determine the role's displayed status; superseded runs from an earlier attempt, generation, or round SHALL NOT influence the label. When several roles share one tab, the glyph SHALL be the aggregate of the latest-per-role statuses ordered by urgency, with outstanding work ahead of terminal states.

#### Scenario: Superseded failed run does not pin the glyph

- **WHEN** a role's earlier run is `failed` or `blocked` and that role's latest run is `completed`
- **THEN** the tab SHALL show the completed glyph (`✓`)
- **AND** the superseded `failed`/`blocked` status SHALL NOT keep the tab on `✗`/`■`

#### Scenario: Reactivated role shows working again

- **WHEN** a role's latest run is `working` after an earlier run on the same tab was `completed`, `failed`, or `blocked`
- **THEN** the tab SHALL show the working glyph (`●`)

#### Scenario: Grouped tab aggregates the latest run per role

- **WHEN** a tab is shared by several roles, such as the verification group
- **THEN** each role SHALL contribute only its latest run's status to the aggregation
- **AND** the displayed glyph SHALL be the most urgent of those latest-per-role statuses

### Requirement: Reused-pane runs carry their tab identity

When a launch adopts an existing live agent's pane instead of creating a new tab, the run's persisted handle SHALL include that pane's tab id, so the reused run can be reconciled onto the agent tab it actually occupies.

#### Scenario: Reused run handle records the adopted tab

- **WHEN** pane allocation resolves a live agent for the run's canonical identity and reuses its pane
- **THEN** the allocation result SHALL include the resolved pane's tab id
- **AND** the persisted run handle SHALL let the reconcile include that run for the tab

### Requirement: Reconcile after drains is idempotent and best-effort

The tab label SHALL be reconciled after the effect drain that commits run status transitions, using the persisted run status as the single source. The reconcile SHALL rename only tabs whose rendered label differs, SHALL skip tabs that are missing or closed, and SHALL NOT fail the drain it follows when Herdr is unavailable or errors.

#### Scenario: Terminal transition renames the tab

- **WHEN** a run transitions to a terminal status during a drain
- **THEN** the reconcile after that drain SHALL rename the run's tab to the glyph for the aggregated latest-per-role status

#### Scenario: Repeated reconcile is idempotent

- **WHEN** the reconcile runs again for a tab already showing the desired label
- **THEN** it SHALL NOT issue a rename

#### Scenario: Herdr failure never fails the drain

- **WHEN** Herdr is unavailable or a tab rename errors during the reconcile
- **THEN** the reconcile SHALL swallow the failure
- **AND** the workflow drain result SHALL be unchanged
