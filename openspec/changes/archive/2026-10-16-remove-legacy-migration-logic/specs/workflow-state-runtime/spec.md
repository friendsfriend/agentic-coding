## REMOVED Requirements

### Requirement: Safe legacy migration

**Reason**: The application no longer imports historical workflow records or mirrors into the current store.
**Migration**: No in-product conversion is provided. Run the version that wrote the historical state in an isolated copy if it must be inspected; the current build leaves unsupported files untouched.

#### Scenario: Historical workflow rows are not imported
- **WHEN** a current workflow operation encounters an old `workflows` table or legacy change ID
- **THEN** it SHALL reject the unsupported store without inserting, translating, or diagnosing imported workflow rows

### Requirement: Versioned store initialization

**Reason**: Ordered upgrades, unversioned shape inference, and automatic schema repair are no longer supported.
**Migration**: Existing non-v6 stores require a separately managed conversion outside this build; the current build SHALL not modify them.

#### Scenario: Non-v6 initialized store is refused
- **WHEN** an existing store has a schema version other than 6
- **THEN** initialization SHALL fail before writing any schema or data

### Requirement: Ordinary reads do not initialize storage

**Reason**: The former migration-required read projection is replaced by a strict current-version boundary.
**Migration**: Current v6 stores continue to be observed read-only; missing stores remain absent and older stores receive the unsupported-version error.

#### Scenario: Old store read is refused
- **WHEN** status/list/view observes an existing non-v6 store
- **THEN** it SHALL expose `unsupported workflow store version N; this build only reads version 6` without creating or modifying the store

## ADDED Requirements

### Requirement: Current workflow store version boundary
The workflow runtime SHALL create a genuinely empty store directly in the frozen schema version 6 and SHALL open an existing version 6 store without altering its schema, rows, or version pragma. Every other existing version SHALL be refused without mutation.

#### Scenario: Fresh store is created at version 6
- **WHEN** the workflow runtime initializes a new empty store
- **THEN** it SHALL create the current version 6 tables, columns, indexes, and constraints directly
- **AND** it SHALL set `PRAGMA user_version` to 6

#### Scenario: Existing v6 store opens unchanged
- **WHEN** a v6 store with current workflow data is opened
- **THEN** the runtime SHALL preserve every existing table, column, index, row, and pragma
- **AND** current reads and writes SHALL continue to work

#### Scenario: Any other existing version is rejected without writes
- **WHEN** a nonempty store has a user version other than 6
- **THEN** the runtime SHALL fail with `unsupported workflow store version N; this build only reads version 6`
- **AND** its schema, rows, and file contents SHALL remain unchanged

#### Scenario: Absent store remains observationally absent
- **WHEN** a status or list read encounters no workflow database
- **THEN** it SHALL report the absent state without creating a file or initializing a database

## MODIFIED Requirements

### Requirement: Effect evidence preparation retains transactional authorization
Effect-based evidence preparation SHALL preserve existing bounded artifact capture, source/run binding, secure filesystem access, and transactional reauthorization. It SHALL not consume capabilities before successful validation, weaken source fingerprint scope, or impose exact developer-revision semantics on independent active agent runs.

#### Scenario: Artifact is replaced during preparation
- **WHEN** assigned evidence or its bound source changes before acceptance
- **THEN** the runtime SHALL reject or securely reprepare it according to the established evidence policy
- **AND** no unvalidated output SHALL commit

#### Scenario: Sibling run commits first
- **WHEN** another valid parallel run advances the revision while evidence is prepared
- **THEN** the current run SHALL be reauthorized against current state and its active generation rather than rejected solely for the sibling's revision change

#### Scenario: Observer accesses an absent or unsupported store
- **WHEN** an Effect status/list/view operation opens an absent store or a store whose schema version is not the supported one
- **THEN** it SHALL return the absent diagnostic or `unsupported workflow store version N; this build only reads version 6` without initialization, import, expiry mutation, or effect claims
