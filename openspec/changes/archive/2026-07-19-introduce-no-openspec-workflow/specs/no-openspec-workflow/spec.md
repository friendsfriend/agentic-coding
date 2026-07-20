## ADDED Requirements

### Requirement: No-openspec workflow creation
The system SHALL support creating a workflow that starts in `apply` phase with the worker running, composed from the `apply-verify`, `developer-approval`, `git-operations`, and `archive` modules, without requiring OpenSpec artifacts.

#### Scenario: CLI creates no-openspec workflow
- **GIVEN** a repository with an initialized Herdr workflow config
- **WHEN** developer runs `herdr-workflow start --repo <repo> --change <change> --task "<task>" --workflow-type no-openspec`
- **THEN** system SHALL set `workflowModules` in state to `["apply-verify", "developer-approval", "git-operations", "archive"]`
- **AND** system SHALL set `workflowType` in state to `"no-openspec"`
- **AND** system SHALL set initial phase to `apply` (entry of first module)
- **AND** system SHALL launch the worker agent (apply-verify module's role)
- **AND** system SHALL NOT require `proposal.md`, `design.md`, `tasks.md`, or spec scenarios under `openspec/changes/<change>/`
- **AND** SHALL NOT run plan quality gate

#### Scenario: No-openspec worker reads request.md not OpenSpec tasks
- **GIVEN** a no-openspec workflow in `apply` phase
- **WHEN** the worker agent is prompted
- **THEN** the prompt SHALL reference `.herdr-workflow/<change>/request.md` as the change description
- **AND** SHALL NOT reference OpenSpec task tracking or task checkboxes

#### Scenario: No-openspec verification skips task completion check
- **GIVEN** a no-openspec workflow in `apply` phase with worker work finished
- **WHEN** developer runs `herdr-workflow verify --repo <repo> --change <change>`
- **THEN** system SHALL NOT call `ensure_tasks_complete`
- **AND** SHALL proceed to triage and verification as in standard workflow

#### Scenario: No-openspec transitions through full lifecycle
- **GIVEN** a no-openspec workflow
- **WHEN** developer completes apply, verify, and approves at developer-review
- **THEN** system SHALL transition to `committing` phase (entry of git-operations)
- **AND** SHALL launch git agent
- **AND** after git agent completes, SHALL transition to `archive` phase
- **AND** after archive cleanup, SHALL transition to `completed`
- **AND** SHALL NOT require any OpenSpec artifact paths to exist

### Requirement: Default workflow type preserves existing behavior
The system SHALL default to `standard` workflow type when no `--workflow-type` is provided, preserving all existing behavior.

#### Scenario: Default start is standard
- **GIVEN** existing codebase
- **WHEN** developer runs `herdr-workflow start --repo <repo> --change <change> --task "<task>"` (without `--workflow-type`)
- **THEN** system SHALL create workflow with `workflowType` set to `"standard"`
- **AND** state's `workflowModules` SHALL be `["plan", "plan-approval", "apply-verify", "developer-approval", "git-operations", "archive"]`
- **AND** initial phase SHALL be `"explore"` with planner launched
- **AND** plan quality gate SHALL run at proposed transition

#### Scenario: Legacy workflow backward compatibility
- **GIVEN** existing workflow state without `workflowType` or `workflowModules` fields
- **WHEN** system reads state
- **THEN** system SHALL treat `workflowType` as `"standard"`
- **AND** SHALL treat `workflowModules` as standard module list
- **AND** all phase transitions, dashboard rendering, and approval gates SHALL be identical to current behavior

### Requirement: Dashboard displays no-openspec workflow
The system SHALL render workflow type and module information in the dashboard.

#### Scenario: Dashboard shows no-openspec detail
- **GIVEN** no-openspec workflow in `apply` phase
- **WHEN** dashboard loads workflow detail
- **THEN** change panel SHALL display workflow type `"no-openspec"`
- **AND** agents panel SHALL show worker (not planner)
- **AND** no approval gate SHALL display (worker already running)
- **AND** module list SHALL show 4 modules
