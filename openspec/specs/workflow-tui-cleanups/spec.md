# workflow-tui-cleanups Specification

## Purpose
TBD - created by archiving change workflow-tui-cleanups. Update Purpose after archive.
## Requirements
### Requirement: Single otel trace-view module
The otel trace-view code SHALL exist once and be shared between the dashboard's trace tab and the standalone `otel-tui` binary.

#### Scenario: No duplicated viewer
- **WHEN** a developer inspects the trace-view code (`TraceBrowser`, `traces`, `receiver`)
- **THEN** it SHALL be defined in one shared module
- **AND** both the dashboard trace tab and the `otel-tui` binary SHALL import it rather than keeping separate copies

### Requirement: Consistent agent naming
The Herdr agent name and the pi `--name` for a role SHALL agree and SHALL be scoped by `{workspace}-{role}`.

#### Scenario: Same change in different workspaces
- **WHEN** role agents for the same change are launched in different workspaces
- **THEN** their agent names SHALL differ

#### Scenario: Names match within the Herdr limit
- **WHEN** a workspace ID is too long or contains unsupported agent-name characters
- **THEN** one naming helper SHALL replace the workspace portion with a deterministic valid token while preserving the role suffix
- **AND** the Herdr agent name and pi `--name` SHALL be equal and no longer than 32 characters

### Requirement: Legacy dead paths removed
Superseded helpers SHALL be removed.

#### Scenario: Dead code gone
- **WHEN** a developer greps the codebase after this change
- **THEN** `startWorkflowWizard` and `pi_command` SHALL NOT be present
- **AND** no call sites SHALL reference them

