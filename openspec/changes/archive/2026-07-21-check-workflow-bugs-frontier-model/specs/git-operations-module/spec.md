## MODIFIED Requirements

### Requirement: Git-operations module
The system SHALL provide a `git-operations` module that stages, commits, and pushes changes after the archive step. For standard and direct-apply workflows the OpenSpec archive move is performed by the preceding archive module and is staged by git-operations. Git-operations is the final module.

#### Scenario: Git-operations module definition
- **GIVEN** the workflow module registry
- **WHEN** system reads `WORKFLOW_MODULES`
- **THEN** SHALL contain an entry `"git-operations"` with:
  - `entry: "committing"`
  - `exit: "completed"`
  - `roles: ["git"]`
  - `gate: False`
  - `phases: {"committing"}`

#### Scenario: Git-operations is after archive in standard
- **GIVEN** standard workflow type definition
- **WHEN** system reads `WORKFLOW_TYPES["standard"]`
- **THEN** module list SHALL be `["plan", "plan-approval", "apply-verify", "developer-approval", "archive", "git-operations"]`

#### Scenario: Git-operations is after archive in direct-apply
- **GIVEN** direct-apply workflow type definition
- **WHEN** system reads `WORKFLOW_TYPES["direct-apply"]`
- **THEN** module list SHALL be `["apply-verify", "developer-approval", "archive", "git-operations"]`

#### Scenario: Git-operations is after archive in no-openspec
- **GIVEN** no-openspec workflow type definition
- **WHEN** system reads `WORKFLOW_TYPES["no-openspec"]`
- **THEN** module list SHALL be `["apply-verify", "developer-approval", "archive", "git-operations"]`

### Requirement: Developer approval routes to git-operations
When the developer approves at the `developer-review` gate, the system SHALL start the archive module first, and the `git-operations` module SHALL run only after archive completes.

#### Scenario: Developer approval starts archive
- **GIVEN** a workflow with `archive` and `git-operations` modules in state
- **WHEN** dashboard sends the archive command from `developer-review` phase
- **THEN** the system SHALL start the archive role
- **AND** SHALL set phase to `archive`

#### Scenario: Archive completion starts git-operations
- **GIVEN** a workflow in `archive` phase with the archive step complete and a clean, stageable tree
- **WHEN** the archive role advances the workflow
- **THEN** the system SHALL transition from `archive` to `committing`
- **AND** SHALL start the git role

#### Scenario: Git completion finalizes the workflow
- **GIVEN** a workflow in `committing` phase with the git agent running
- **WHEN** commit and push succeed
- **THEN** the git agent SHALL advance the workflow from `committing` to `completed`
- **AND** SHALL NOT re-enter the `archive` phase

### Requirement: Archive module simplified
The archive module SHALL run before git-operations and, for standard and direct-apply workflows, SHALL perform the OpenSpec archive move so the change directory is relocated before commit. For no-openspec it SHALL only validate. It SHALL NOT commit or push. It SHALL NOT close the workspace or finalize the trace; those remain the responsibility of the final `git-operations`/`completed` step.

#### Scenario: Archive moves the change directory before commit
- **GIVEN** a standard or direct-apply workflow in `archive` phase
- **WHEN** the archive agent runs
- **THEN** it SHALL run `openspec archive` to move `openspec/changes/<change>/` into `openspec/changes/archive/`
- **AND** it SHALL leave a clean, stageable working tree
- **AND** it SHALL NOT create a git commit or push
- **AND** it SHALL advance the workflow to `committing`

#### Scenario: No-openspec archive validates only
- **GIVEN** a no-openspec workflow in `archive` phase
- **WHEN** the archive agent runs
- **THEN** it SHALL validate only and SHALL NOT run `openspec archive`
- **AND** it SHALL advance the workflow to `committing`
