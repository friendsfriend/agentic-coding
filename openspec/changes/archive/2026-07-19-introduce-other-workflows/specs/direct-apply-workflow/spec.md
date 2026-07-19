## ADDED Requirements

### Requirement: Direct-apply workflow creation
The system SHALL support creating a workflow that starts in `apply` phase with the worker running, composed from the `apply-verify`, `developer-approval`, and `archive` modules.

#### Scenario: CLI creates direct-apply workflow
- **GIVEN** pre-authored `proposal.md`, `design.md`, `tasks.md`, and spec scenarios exist under `openspec/changes/<change>/`
- **WHEN** developer runs `herdr-workflow start --repo <repo> --change <change> --task "<task>" --workflow-type direct-apply`
- **THEN** system SHALL set `workflowModules` in state to `["apply-verify", "developer-approval", "archive"]`
- **AND** system SHALL set initial phase to `apply` (entry of first module)
- **AND** system SHALL NOT launch a planner agent (plan module absent)
- **AND** system SHALL launch the worker agent (apply-verify module's role)
- **AND** SHALL NOT run plan quality gate

#### Scenario: Default workflow type preserves existing behavior
- **GIVEN** existing codebase
- **WHEN** developer runs `herdr-workflow start --repo <repo> --change <change> --task "<task>"` (without `--workflow-type`)
- **THEN** system SHALL create workflow with phase `"explore"` and launch planner
- **AND** state's `workflowModules` SHALL be `["plan", "plan-approval", "apply-verify", "developer-approval", "archive"]`
- **AND** all existing behavior (plan quality gate, proposed transition, dashboard approval) SHALL be preserved

#### Scenario: Legacy workflow backward compatibility
- **GIVEN** existing workflow state without `workflowModules` field
- **WHEN** system reads state
- **THEN** system SHALL treat the workflow as standard module list
- **AND** all phase transitions and dashboard rendering SHALL be identical to current behavior

### Requirement: Apply-verify module internal lifecycle
The system SHALL support the apply → verify → fix loop as a single indivisible module with the same internal gates as today.

#### Scenario: Direct-apply transitions through verification
- **GIVEN** direct-apply workflow in `apply` phase with worker completed
- **WHEN** developer runs `herdr-workflow phase --repo <repo> --change <change> verify`
- **THEN** system SHALL transition to `verify` phase (internal to apply-verify module)
- **AND** on verifier failure SHALL transition to `fix` phase
- **AND** on fix complete SHALL retry `verify`
- **AND** on all verifiers pass SHALL transition to `developer-review` (exit to next module)

#### Scenario: Paused phase within apply-verify module
- **GIVEN** direct-apply workflow in `verify` phase with timeout
- **WHEN** timeout handler triggers
- **THEN** system SHALL transition to `paused` phase within apply-verify module
- **AND** from paused, developer SHALL resume to `fix` or `verify`
- **AND** this SHALL match standard workflow behavior

### Requirement: Module gate transitions
The system SHALL enforce dashboard approval gates only at module boundaries where `gate: True`.

#### Scenario: Developer approval gate for direct-apply
- **GIVEN** direct-apply workflow in `developer-review` phase (exit of apply-verify, entry of developer-approval module)
- **WHEN** developer presses Enter to approve
- **THEN** system SHALL transition to `archive` phase
- **AND** archive module SHALL launch archive agent

### Requirement: Dashboard displays module-aware workflow
The system SHALL render workflow type and module information in the dashboard.

#### Scenario: Dashboard shows direct-apply detail
- **GIVEN** direct-apply workflow in `apply` phase
- **WHEN** dashboard loads workflow detail
- **THEN** change panel SHALL display workflow type `"direct-apply"`
- **AND** agents panel SHALL show worker (not planner)
- **AND** no approval gate SHALL display (worker already running)
