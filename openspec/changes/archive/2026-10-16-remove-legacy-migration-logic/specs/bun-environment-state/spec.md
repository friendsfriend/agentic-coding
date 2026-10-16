## MODIFIED Requirements

### Requirement: Compatible environment SQLite state
Bun SHALL read and write the current environment state schema version 9 using its existing schema and identity semantics, preserving branches, active worktrees, run targets, script history, action/output history and dependency leases. A new database SHALL be created directly at version 9. An existing database with any other schema version SHALL be refused or ignored without changing its schema, version, backup files, or rows. Workflow and telemetry databases SHALL remain separate.

#### Scenario: Current v9 state is opened
- **WHEN** Bun opens a current schema v9 state database
- **THEN** all current persisted values, nullability, ordering and retention behavior SHALL remain available
- **AND** no workflow pin or repository location SHALL be rewritten

#### Scenario: Fresh state is initialized at v9
- **WHEN** Bun opens a genuinely empty state database
- **THEN** it SHALL create the current v9 schema directly without applying historical schema steps

#### Scenario: Unsupported environment schema is not modified
- **WHEN** state has an older, newer, or otherwise unsupported schema version
- **THEN** Bun SHALL fail closed or ignore the file without modifying it

## REMOVED Requirements

### Requirement: One state writer during mixed-runtime migration

**Reason**: The staged mixed-runtime migration and its Go state bridge are no longer a supported product state.
**Migration**: Current environment operations use the Bun-owned current state authority; no dual-writer transition is provided.

#### Scenario: No legacy writer transition
- **WHEN** the current Bun server opens environment state
- **THEN** it SHALL not invoke or coordinate with a historical Go schema writer

### Requirement: Safe ownership and migration cutover

**Reason**: Automatic schema cutover, migration locking, pre-upgrade backup and rollback handling are removed.
**Migration**: Keep or externally back up existing state before changing application versions; this build will not upgrade or roll back it.

#### Scenario: Older state remains untouched
- **WHEN** startup encounters an older environment database
- **THEN** it SHALL refuse or ignore it without taking a conversion backup, applying DDL, or advancing the version
