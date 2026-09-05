## ADDED Requirements

### Requirement: Repository-scoped configuration context
Workflow startup and related configuration reads/edits SHALL resolve project overlays from an explicit selected canonical repository context, not the host process working directory. Configuration provenance SHALL identify the effective sources. An explicit HERDR_WORKFLOW_CONFIG replacement SHALL retain precedence over user defaults and project overlays.

#### Scenario: Another repository is selected
- **WHEN** a process launched from repository A starts a workflow targeting repository B
- **THEN** repository B's canonical project overlay SHALL be selected over user defaults
- **AND** repository A's project overlay SHALL not influence that start

#### Scenario: Startup targets a linked worktree
- **WHEN** startup targets a linked worktree of a repository
- **THEN** its project overlay SHALL resolve from the same canonical repository context used for that repository's workflow configuration

#### Scenario: Repository-independent workflow has no repository context
- **WHEN** research or internal wiki startup has no explicitly selected repository context
- **THEN** configuration SHALL use the explicit replacement or user defaults without an ambient cwd project overlay

#### Scenario: Explicit configuration replacement is supplied
- **WHEN** HERDR_WORKFLOW_CONFIG selects a configuration file
- **THEN** it SHALL replace the user/project configuration selection for that operation
- **AND** no project overlay SHALL shadow it

#### Scenario: Dashboard edits selected configuration
- **WHEN** the dashboard edits profiles or presets for an explicit repository context
- **THEN** reads and write-back SHALL resolve the same effective source and preserve layered-source conflict checks
- **AND** the UI SHALL identify that source without treating repository executable settings as untrusted inert data

### Requirement: Pinned non-secret execution settings
Workflow creation SHALL persist the accepted non-secret settings required by later configuration-sensitive effects, including the delivery remote and PR executable selection or its explicit unavailability. Later effects SHALL use those settings rather than rereading the drainer's ambient configuration. Credentials SHALL not be persisted in this record.

#### Scenario: Delivery configuration changes after start
- **WHEN** configuration changes or another process drains an already-started workflow from another directory
- **THEN** delivery and PR effects SHALL retain that workflow's accepted settings
- **AND** no new remote or executable SHALL be selected implicitly

#### Scenario: Legacy workflow lacks execution settings
- **WHEN** a workflow without accepted execution settings reaches a configuration-sensitive effect
- **THEN** that effect SHALL stop with an actionable settings-adoption diagnostic
- **AND** status SHALL remain readable without choosing settings on the user's behalf

#### Scenario: Operator adopts legacy settings
- **WHEN** an operator previews and confirms validated settings against the current workflow revision through repair or migration
- **THEN** the engine SHALL atomically record the accepted settings and an audit event
- **AND** a stale or invalid adoption SHALL leave settings and effects unchanged
