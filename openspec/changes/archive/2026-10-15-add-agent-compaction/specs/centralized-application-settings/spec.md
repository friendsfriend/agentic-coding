# Spec Delta: centralized-application-settings

## Purpose

Settings gains a user-scoped Compaction section for the durable runs' compaction
policy, edited with a bounded numeric editor and persisted through the existing
server-owned `[agents]` write path.

## ADDED Requirements

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
