# bun-environment-state Specification

## Purpose
Bun owns the canonical environment configuration (app/library/infrastructure
definitions and the project catalog) and the environment SQLite state, while the
remaining Go services reach both through bounded private typed operations during
the staged runtime migration.
## Requirements
### Requirement: Bun owns canonical environment configuration
Bun SHALL provide app/library/infrastructure loading, catalog projection and runtime path resolution with compatible configuration precedence, stable identities and validation. Environment configuration SHALL use the shared canonical root, defaulting to `~/.config/agentic-coding`, preserving its JSON definition layout and `.env` credential references. Runtime state SHALL remain separate from static configuration files and SHALL NOT relocate as a side effect of configuration migration.

#### Scenario: Active worktree is missing
- **WHEN** a configured active linked worktree no longer exists
- **THEN** Bun SHALL apply the captured managed-path fallback behavior and report availability consistently with the established catalog contract
- **AND** it SHALL NOT rewrite the static app definition with runtime fields

#### Scenario: Configuration reload fails
- **WHEN** a new configuration snapshot cannot be validated
- **THEN** callers SHALL receive a diagnostic and SHALL NOT observe a partially published catalog/registry configuration

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

