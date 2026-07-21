## ADDED Requirements

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
