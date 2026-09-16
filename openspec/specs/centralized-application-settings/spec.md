# centralized-application-settings Specification

## Purpose
TBD - created by archiving change centralize-application-settings. Update Purpose after archive.
## Requirements
### Requirement: Settings is the unified configuration destination
Home SHALL expose Settings with Appearance, Agent models/presets, Providers/credentials, Projects/environments and Backend/telemetry sections. Every supported application configuration setting SHALL have an inventoried destination; read-only overrides SHALL identify their controlling source. Persistent model/profile/preset management SHALL NOT require a workflow list or dashboard.

#### Scenario: Configure without workflows
- **WHEN** no workflows exist and the user opens Settings
- **THEN** existing supported configuration capabilities SHALL remain available without starting or selecting a workflow

### Requirement: Explicit source and scope
Settings SHALL identify effective source, editing scope and override precedence. Application/library shortcuts SHALL open the same settings implementation scoped to that stable project ID. Client-local preferences SHALL remain local; connected-server settings SHALL use authenticated server APIs without local fallback writes.

#### Scenario: Attached project settings
- **WHEN** an attached client edits a configured application's agent settings
- **THEN** the owning server SHALL validate and write the resolved project configuration
- **AND** the client's unrelated local repository configuration SHALL remain unchanged

#### Scenario: Read-only override
- **WHEN** a setting is controlled by a non-editable environment or CLI override
- **THEN** Settings SHALL show that source and SHALL NOT report an ineffective edit as changing the effective value

### Requirement: Safe configuration and credential persistence
Settings SHALL validate mutations, preserve unrelated fields and source formats, detect conflicting writes, and report failures without losing unsaved input or the last valid persisted state. Saved credentials SHALL remain protected and SHALL NOT be disclosed in navigation state, UI preference files, logs or telemetry.

#### Scenario: Concurrent modification
- **WHEN** another client changes the source after an editor loads it
- **THEN** saving SHALL detect or safely reconcile the conflict rather than blindly overwrite the other client's changes

#### Scenario: Credential edit
- **WHEN** the user manages provider credentials
- **THEN** the existing protected credential flow SHALL be used and stored secret values SHALL remain masked

### Requirement: Configuration application is explicit
Settings SHALL identify immediate versus restart-required effects. Persistent agent edits SHALL affect subsequent workflow starts without silently changing existing definition/configuration pins or revisions. Editing server configuration SHALL NOT implicitly restart or stop an unowned server.

#### Scenario: Save preset during active workflow
- **WHEN** a user saves a preset used by an active workflow
- **THEN** that workflow's pinned execution SHALL remain unchanged absent its existing explicit revision-bound adoption operation

#### Scenario: Receiver setting needs restart
- **WHEN** a receiver configuration cannot safely apply live
- **THEN** Settings SHALL report the restart requirement without silently restarting the server

