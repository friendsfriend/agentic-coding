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

### Requirement: Compaction settings section

Home → Settings SHALL expose a Compaction section listing `enabled`, the reserve,
the background threshold and the keep-recent value with their effective resolved
values, the reference context window the percentages resolved against, whether
the value came from `[agents.compaction]` or the `agentHost.compaction` override,
and the documented defaults. The values SHALL be stored under `[agents.compaction]`
in the canonical layered workflow configuration at user scope, so a project
overlay's `[agents]` section SHALL NOT capture the write and SHALL NOT change the
effective policy. Saving SHALL validate every field, reject an out-of-bounds value
naming the field without losing the editor's input or the last valid stored state,
and detect a concurrent write the way the other `[agents]` mutations do. A saved
value SHALL be reported as applying to running durable conversations.

#### Scenario: Section shows the effective policy

- **WHEN** the developer opens Settings → Compaction with no configuration present
- **THEN** the section SHALL show `enabled: true`, the documented reserve, background and keep-recent values, and SHALL mark them as defaults

#### Scenario: Value edited

- **WHEN** the developer edits the reserve with the numeric editor and saves
- **THEN** `[agents.compaction]` SHALL be updated in the user-level configuration and the section SHALL show the new effective value

#### Scenario: Invalid value rejected

- **WHEN** the developer enters a value outside the field's bounds
- **THEN** the editor SHALL report the validation error and no write SHALL occur

#### Scenario: Concurrent write

- **WHEN** another client changes the agents configuration after the editor loaded it
- **THEN** the save SHALL be refused as stale and the stored configuration SHALL remain unchanged

#### Scenario: Project overlay cannot capture the write

- **WHEN** the selected project's overlay contains an `[agents]` section
- **THEN** a compaction save SHALL still write the user-level configuration and the host SHALL resolve that value

### Requirement: Bounded numeric editor

Settings SHALL offer a numeric editor for a bounded numeric setting: it SHALL
accept only a whole number within the field's bounds, optionally in the
percentage form the field documents, SHALL report an invalid entry inline, and
SHALL apply only on explicit confirmation and discard on cancel.

#### Scenario: Invalid keystroke

- **WHEN** the developer types a character that cannot be part of a valid value
- **THEN** the editor SHALL NOT accept it and the entered value SHALL stay invalid-free

#### Scenario: Cancelled edit

- **WHEN** the developer cancels the editor after typing a different value
- **THEN** the stored configuration and the section's displayed value SHALL be unchanged

### Requirement: Settings accepts pointer input

The Settings section list SHALL select a row on a tap and perform that row's
activation (open the theme picker, navigate, open the numeric editor, reload or
start a browser install) on a tap of the already-selected row. The bounded
numeric editor SHALL focus its field on a tap and expose its accept and cancel
actions as pointer targets. The agent preset view SHALL select and activate its
menu, list, pool and picker rows on tap, focus its text, select and numeric
fields on tap, and keep its destructive confirmation explicit — a backdrop tap
SHALL never confirm a deletion or discard a draft.

#### Scenario: Activating a section row

- **WHEN** the developer taps a Settings row that is already selected and the row performs an action
- **THEN** the same action SHALL run once
- **AND** a read-only row SHALL select without performing an action

#### Scenario: Numeric editor draft

- **WHEN** the developer taps outside the bounded numeric editor while it holds an edited value
- **THEN** the editor SHALL stay open with the value unchanged
- **AND** its field, accept and cancel targets SHALL respond to taps

#### Scenario: Preset view delete confirmation

- **WHEN** the developer taps outside a pending delete confirmation in the agent preset view
- **THEN** no deletion SHALL happen
- **AND** the confirmation SHALL remain until an explicit control confirms or cancels it

#### Scenario: Settings keyboard behavior is unchanged

- **WHEN** the developer navigates, activates, reloads and edits with the keyboard
- **THEN** every Settings key SHALL behave as before
- **AND** saved values, scopes and validation messages SHALL be unchanged

