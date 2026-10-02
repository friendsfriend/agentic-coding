## ADDED Requirements

### Requirement: Legacy pi runtime is rejected with migration guidance
Configuration parsing SHALL reject profiles or presets selecting runtime `pi` with a diagnostic naming the configuration migration command, and the migration SHALL rewrite them to `pi-durable` while preserving model and thinking values.

#### Scenario: Configuration still names pi
- **WHEN** a user's configuration contains a profile with runtime `pi`
- **THEN** workflow start SHALL fail before launch with a diagnostic naming `agentic-coding config migrate`

#### Scenario: Migration rewrites pi profiles
- **WHEN** the user runs the configuration migration with apply
- **THEN** each `pi` profile SHALL become a `pi-durable` profile with the same model and a backup of the original SHALL be kept

### Requirement: Pinned pi workflows are not silently re-routed
An active workflow whose pinned route uses `pi` SHALL NOT be resumed on another runtime implicitly.

#### Scenario: Resume of a pi-pinned workflow
- **WHEN** a drain reaches a run of a workflow pinned to `pi`
- **THEN** the workflow SHALL become attention-required with repair guidance
