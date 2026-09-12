# merged-repository-foundation Specification

## Purpose
TBD - created by archiving change import-devenv-into-agentic-coding. Update Purpose after archive.
## Requirements
### Requirement: Reproducible in-repository source ownership
The merged repository SHALL contain the imported devenv source, tests and required assets at a recorded source revision and SHALL NOT require a second devenv checkout to run or build. Import provenance and applicable license notices MUST be retained.

#### Scenario: Build without original checkout
- **WHEN** a developer installs dependencies from the merged checkout with `~/devenv` unavailable
- **THEN** both retained application entrypoints SHALL resolve only imported source and declared dependencies
- **AND** the source revision and import manifest SHALL be available in documentation

#### Scenario: User data is excluded
- **WHEN** devenv source is imported
- **THEN** credentials, local databases, generated binaries and node_modules SHALL NOT be copied as source artifacts

### Requirement: Shared tooling preserves both verification suites
The TypeScript application SHALL use one Bun workspace dependency graph and lockfile with a single OpenTUI/Solid resolution, Biome lint/format/import rules and TypeScript checking. Combined verification SHALL include both Bun test suites and Go tests/vet while Go remains.

#### Scenario: Unified verification runs
- **WHEN** the combined verification entrypoint executes
- **THEN** failures in either application's tests, TypeScript checks, Biome checks or Go checks SHALL fail the command
- **AND** no existing workflow architecture check SHALL be silently disabled

### Requirement: Feature and migration parity inventory
The import SHALL establish a versioned inventory covering both applications' features, subviews, routes, actions, commands, config/data locations and platform support, with old owner, intended owner, evidence and migration status for each item.

#### Scenario: Later port claims completion
- **WHEN** a migration change marks a feature or route as migrated
- **THEN** the inventory SHALL identify its replacement and acceptance evidence
- **AND** removing its user-facing entrypoint SHALL NOT count as preserving the feature

### Requirement: Import leaves execution behavior unchanged
Source import SHALL preserve existing workflow commands and environment functionality without relocating repositories, modifying domain stores or reviving removed phase-specific workflow verbs.

#### Scenario: Existing workflow state is opened after import
- **WHEN** a supported persisted workflow is inspected using imported application code
- **THEN** its identity, definition pins and read-only observation behavior SHALL remain unchanged

