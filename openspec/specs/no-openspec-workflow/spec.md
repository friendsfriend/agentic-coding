# no-openspec-workflow Specification

## Purpose
TBD - created by archiving change introduce-no-openspec-workflow. Update Purpose after archive.
## Requirements
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

### Requirement: No-openspec workflow starts without an OpenSpec project
The system SHALL allow starting a `no-openspec` workflow in a repository that has no `openspec/config.yaml`, while still enforcing a clean working tree.

#### Scenario: No-openspec start skips OpenSpec project check
- **GIVEN** a clean repository with no `openspec/config.yaml`
- **WHEN** developer runs `herdr-workflow start --repo <repo> --change <change> --task "<task>" --workflow-type no-openspec`
- **THEN** system SHALL NOT raise `OpenSpec project not found`
- **AND** system SHALL still verify the working tree is clean and abort if it is dirty
- **AND** system SHALL create the workflow in `apply` phase with the worker running

#### Scenario: Standard and direct-apply still require OpenSpec
- **GIVEN** a clean repository with no `openspec/config.yaml`
- **WHEN** developer runs `herdr-workflow start` with `--workflow-type standard` or `--workflow-type direct-apply` (or no `--workflow-type`)
- **THEN** system SHALL raise `OpenSpec project not found` and abort

#### Scenario: Dirty tree still blocks no-openspec start
- **GIVEN** a repository with uncommitted changes
- **WHEN** developer runs `herdr-workflow start ... --workflow-type no-openspec`
- **THEN** system SHALL abort with a dirty-working-tree error

### Requirement: No-openspec worker guidance is self-consistent
The system SHALL give the no-openspec worker instructions that do not require an OpenSpec `tasks.md` and that name the exact command to start verification.

#### Scenario: No-openspec worker prompt names the verify command
- **GIVEN** a no-openspec workflow in `apply` phase
- **WHEN** the worker agent is prompted
- **THEN** the prompt SHALL reference `.herdr-workflow/<change>/request.md` as the change description
- **AND** the prompt SHALL instruct the worker to run `herdr-workflow verify --repo . --change <change>` once the change is applied
- **AND** the prompt SHALL NOT instruct the worker to read or update OpenSpec task checkboxes

#### Scenario: Worker skill task tracking is conditional on tasks.md
- **GIVEN** the loaded `herdr-openspec-worker` skill applies to standard, direct-apply, and no-openspec workers
- **WHEN** a worker follows the skill in a no-openspec workflow with no `openspec/changes/<change>/tasks.md`
- **THEN** the skill SHALL scope the task-checkbox steps to workflows where `tasks.md` exists
- **AND** the skill SHALL NOT direct a no-openspec worker to read or mark a non-existent `tasks.md`
- **AND** the skill guidance SHALL NOT contradict the no-openspec worker prompt

### Requirement: No-openspec archives before git operations
The system SHALL sequence the archive module before the git-operations module in the no-openspec workflow so the archive step completes before commit and push.

#### Scenario: No-openspec module order places archive before git-operations
- **GIVEN** the no-openspec workflow type definition
- **WHEN** system reads `WORKFLOW_TYPES["no-openspec"]`
- **THEN** module list SHALL be `["apply-verify", "developer-approval", "archive", "git-operations"]`
- **AND** `archive` SHALL appear before `git-operations`

#### Scenario: No-openspec phase flow after developer approval
- **GIVEN** a no-openspec workflow in `developer-review` phase with approval granted
- **WHEN** the workflow advances
- **THEN** it SHALL transition `developer-review → archive → committing → completed`
- **AND** the archive role SHALL run before the git role
- **AND** because there is no OpenSpec change directory, the archive role SHALL only validate and SHALL NOT run `openspec archive`

#### Scenario: No-openspec transition table
- **GIVEN** the no-openspec workflow module list
- **WHEN** system computes `allowed_transitions`
- **THEN** `archive` SHALL allow transition to `committing`
- **AND** `committing` SHALL allow transition to `completed`
- **AND** there SHALL be no transition `committing → archive`

