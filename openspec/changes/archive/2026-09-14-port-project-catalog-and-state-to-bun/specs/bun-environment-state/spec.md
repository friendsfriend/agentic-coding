## ADDED Requirements

### Requirement: Bun owns canonical environment configuration
Bun SHALL provide app/library/infrastructure loading, catalog projection and runtime path resolution with compatible configuration precedence, stable identities and validation. Runtime state SHALL remain separate from static configuration files.

#### Scenario: Active worktree is missing
- **WHEN** a configured active linked worktree no longer exists
- **THEN** Bun SHALL apply the captured managed-path fallback behavior and report availability consistently with the established catalog contract
- **AND** it SHALL NOT rewrite the static app definition with runtime fields

#### Scenario: Configuration reload fails
- **WHEN** a new configuration snapshot cannot be validated
- **THEN** callers SHALL receive a diagnostic and SHALL NOT observe a partially published catalog/registry configuration

### Requirement: Compatible environment SQLite state
Bun SHALL read and write supported environment state/history using existing schema and identity semantics, preserving branches, active worktrees, run targets, script history, action/output history and dependency leases. Workflow and telemetry databases SHALL remain separate.

#### Scenario: Go-created state is opened
- **WHEN** Bun opens a fixture created by a supported Go release
- **THEN** all persisted values, nullability, ordering and retention behavior SHALL match the fixture contracts
- **AND** no workflow pin or repository location SHALL be rewritten

#### Scenario: Future schema is encountered
- **WHEN** state has an unsupported future schema version
- **THEN** Bun SHALL fail closed without modifying it

### Requirement: One state writer during mixed-runtime migration
After cutover, Bun SHALL be the sole environment-state schema and mutation authority. Remaining Go services SHALL use authenticated bounded typed state/catalog operations without direct writable SQLite handles or independent config authority.

#### Scenario: Go action persists output
- **WHEN** an unported Go action emits a command-output record
- **THEN** its state operation SHALL be handled once by Bun with the original run/step identity
- **AND** Go SHALL NOT independently append the same event to SQLite

#### Scenario: Logical atomic update crosses private bridge
- **WHEN** an existing state operation requires atomic multi-field updates
- **THEN** the bridge SHALL submit one logical transaction rather than expose arbitrary SQL or split atomicity across requests

### Requirement: Safe ownership and migration cutover
Writer cutover SHALL stop old writers, take a consistent SQLite backup and initialize under migration locking/version validation. Rollback SHALL NOT start an incompatible old writer on newer state.

#### Scenario: Upgrade is interrupted
- **WHEN** startup interrupts schema initialization
- **THEN** reopening SHALL yield a supported committed schema or a safe failure, not partial migration
- **AND** a verified pre-upgrade backup SHALL remain available for deliberate rollback
