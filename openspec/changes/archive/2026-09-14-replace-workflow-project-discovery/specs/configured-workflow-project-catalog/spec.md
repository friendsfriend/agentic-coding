## ADDED Requirements

### Requirement: Configured apps and libraries are discovery authority
Project discovery SHALL use the backend's configured app/library catalog for workflow creation, workflow history, telemetry roots and CLI project listing. Recursive root/cwd/development-directory scanning and legacy TOML discovery SHALL NOT remain as fallbacks. Catalog observation SHALL NOT clone repositories or launch operational pollers/actions.

#### Scenario: Unconfigured repository exists nearby
- **WHEN** an unconfigured Git repository exists under the current directory or old discovery root
- **THEN** it SHALL NOT appear in automatic project/workflow discovery

#### Scenario: Catalog server is unavailable
- **WHEN** a catalog request fails
- **THEN** consumers SHALL show a retryable discovery error rather than presenting success with an empty list or scanning elsewhere

#### Scenario: Headless project listing
- **WHEN** CLI project listing runs without a managed TUI server
- **THEN** it SHALL use the canonical backend catalog through a bounded read-only invocation
- **AND** it SHALL NOT start container pruning, workflow drains or environment mutation

### Requirement: Stable project and checkout identity
Each catalog entry SHALL distinguish stable configured ID, display name, canonical repository root, active checkout, availability and capabilities. Duplicate configured IDs SHALL be rejected with diagnostics; linked worktrees SHALL share canonical repository history.

#### Scenario: Environment active worktree changes
- **WHEN** the operator switches an environment's active checkout
- **THEN** catalog checkout data SHALL update without changing project identity
- **AND** running workflows SHALL retain pinned repository/worktree locations and history SHALL NOT duplicate

#### Scenario: Project is not cloned
- **WHEN** a configured project has no existing local checkout
- **THEN** its configured identity and unavailable status SHALL remain visible
- **AND** starting repository work SHALL require availability rather than silently cloning during discovery

### Requirement: Catalog updates do not destroy workflow resources
Consumers SHALL refresh from catalog changes and adjust watchers by canonical root without deleting history or terminating active workflows when a configured entry is removed.

#### Scenario: Remove configured project with active workflow
- **WHEN** a project is removed from configuration while its workflow remains active
- **THEN** new discovery SHALL omit that project and obsolete catalog watchers SHALL stop
- **AND** explicit workflow detail SHALL retain access and show the catalog mismatch without retargeting the workflow

### Requirement: Standalone targets and explicit CLI targeting remain supported
Centralized wiki/research workflows SHALL remain discoverable outside the project catalog. Explicit authenticated CLI repository targeting SHALL remain supported independently of automatic discovery.

#### Scenario: Catalog is empty
- **WHEN** no apps or libraries are configured
- **THEN** standalone wiki/research workflows SHALL remain accessible
- **AND** empty project state SHALL NOT be treated as a discovery transport failure

### Requirement: Cutover requires manual project reconciliation
Discovery cutover SHALL require an operator-verified configured project inventory. The application SHALL NOT automatically relocate repositories, rewrite workflow locations or add external-checkout support as part of this change.

#### Scenario: Unresolved active workflow location
- **WHEN** reconciliation identifies an active workflow with unresolved absolute-path references
- **THEN** cutover SHALL be blocked until the operator resolves the location safely
- **AND** no automatic move or database rewrite SHALL occur
