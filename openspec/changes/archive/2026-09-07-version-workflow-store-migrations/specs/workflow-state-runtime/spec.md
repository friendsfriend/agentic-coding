## MODIFIED Requirements

### Requirement: Safe legacy migration
The system SHALL automatically import recognized legacy workflow rows into the canonical schema on explicit initialization/import or mutating workflow access, while preserving valid domain data and recording a migration event. Observational status/list/view access SHALL report migration-required instead of importing or issuing fresh runs.

#### Scenario: Equivalent legacy mirrors exist
- **WHEN** explicit initialization/import or mutating access targets a valid legacy workflow with equivalent repository and worktree rows
- **THEN** the engine SHALL map phase and verification state to the pinned built-in step definition
- **AND** commit the canonical migrated snapshot with revision and migration audit event
- **AND** stop relying on the legacy mirror

#### Scenario: Active legacy agent cannot use new protocol
- **WHEN** migration maps active legacy work to an agent step
- **THEN** the engine SHALL expire legacy agent ownership and enqueue fresh run assignment using the new protocol
- **AND** stale legacy completion SHALL NOT mutate the migrated workflow

#### Scenario: Legacy sources conflict or cannot map
- **WHEN** legacy mirrors disagree or legacy data cannot map unambiguously to valid step state
- **THEN** migration SHALL fail closed into a repair-required view
- **AND** the engine SHALL preserve source data for diagnosis rather than choosing an arbitrary version

#### Scenario: Legacy workflow is only observed
- **WHEN** status or list encounters a workflow requiring import
- **THEN** it SHALL expose a migration-required diagnostic without changing source rows, schema, revisions, or outbox entries

#### Scenario: Two callers import the same workflow
- **WHEN** separate processes attempt supported legacy import concurrently
- **THEN** at most one canonical import and migration event SHALL commit for that source workflow
- **AND** both SHALL preserve the legacy source for diagnosis

## ADDED Requirements

### Requirement: Versioned store initialization
Canonical SQLite schema evolution SHALL use ordered migrations recorded in PRAGMA user_version. Initialization SHALL acquire the migration lock and reread the version before deciding which transitions to apply. Each migration SHALL atomically commit its schema/data changes and version advancement, preserving foreign-key integrity.

#### Scenario: Supported unversioned store is initialized
- **WHEN** initialization encounters a recognized historical user_version=0 schema
- **THEN** it SHALL safely identify and migrate that supported shape while preserving workflows, events, runs, capabilities, and outbox identities
- **AND** it SHALL not treat an unknown nonempty schema as a fresh empty store

#### Scenario: Initializers race
- **WHEN** two processes initialize the same old store concurrently
- **THEN** the second lock holder SHALL reread the committed version and skip already-applied migrations
- **AND** duplicate DDL, duplicate imported state, or partial version advancement SHALL not occur

#### Scenario: Migration is interrupted
- **WHEN** a migration fails or its process exits before that migration commits
- **THEN** its DDL/data changes and version advancement SHALL roll back together
- **AND** later initialization SHALL resume from the last committed version

#### Scenario: Rebuilt schema has invalid references
- **WHEN** a migration rebuilding parent or child tables fails foreign-key validation
- **THEN** it SHALL roll back instead of advancing user_version
- **AND** the prior data SHALL remain recoverable with foreign-key enforcement restored on the connection

#### Scenario: Newer unsupported schema is opened
- **WHEN** the store version exceeds the binary's supported migration range
- **THEN** initialization and mutation SHALL fail closed without altering the database
- **AND** the diagnostic SHALL identify the unsupported version

### Requirement: Ordinary reads do not initialize storage
Observational store connections SHALL not run creation DDL, schema repair, or legacy import. Supported initialized stores SHALL be opened using a version check rather than per-open schema-shape inference.

#### Scenario: Current store is read repeatedly
- **WHEN** status/list/view opens a current supported store
- **THEN** it SHALL not create, alter, or rebuild tables or probe historical DDL shapes to decide migrations

#### Scenario: Absent or old store is read
- **WHEN** a read encounters a missing store or one requiring initialization
- **THEN** it SHALL return an absent or migration-required diagnostic without creating or migrating the store
