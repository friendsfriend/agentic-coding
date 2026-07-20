## ADDED Requirements

### Requirement: Git-operations module
The system SHALL provide a `git-operations` module that stages, commits, and pushes changes after developer approval. For standard and direct-apply workflows it additionally syncs OpenSpec artifacts before staging.

#### Scenario: Git-operations module definition
- **GIVEN** the workflow module registry
- **WHEN** system reads `WORKFLOW_MODULES`
- **THEN** SHALL contain an entry `"git-operations"` with:
  - `entry: "committing"`
  - `exit: "archive"`
  - `roles: ["git"]`
  - `gate: False`
  - `phases: {"committing"}`

#### Scenario: Git-operations is after developer-approval in standard
- **GIVEN** standard workflow type definition
- **WHEN** system reads `WORKFLOW_TYPES["standard"]`
- **THEN** module list SHALL be `["plan", "plan-approval", "apply-verify", "developer-approval", "git-operations", "archive"]`

#### Scenario: Git-operations is after developer-approval in direct-apply
- **GIVEN** direct-apply workflow type definition
- **WHEN** system reads `WORKFLOW_TYPES["direct-apply"]`
- **THEN** module list SHALL be `["apply-verify", "developer-approval", "git-operations", "archive"]`

#### Scenario: Git-operations is after developer-approval in no-openspec
- **GIVEN** no-openspec workflow type definition
- **WHEN** system reads `WORKFLOW_TYPES["no-openspec"]`
- **THEN** module list SHALL be `["apply-verify", "developer-approval", "git-operations", "archive"]`

### Requirement: Developer approval routes to git-operations
When the developer approves at the `developer-review` gate and the workflow has a `git-operations` module, the system SHALL start git operations instead of archiving directly.

#### Scenario: Approval starts git operations
- **GIVEN** a workflow with `git-operations` module in state
- **WHEN** dashboard sends archive command from `developer-review` phase
- **THEN** `cmd_archive` SHALL detect `git-operations` in module list
- **AND** SHALL close non-essential agent panes (planner, triage, worker, verifiers)
- **AND** SHALL create a git tab and launch the git agent
- **AND** SHALL set phase to `committing`
- **AND** SHALL set `developerApproval` to `True`
- **AND** SHALL write git context to `reviews/git-context.md`

#### Scenario: Git agent commits and pushes
- **GIVEN** workflow in `committing` phase with git agent running
- **WHEN** git agent completes commit and push successfully
- **THEN** git agent SHALL run `herdr-workflow phase --repo <repo> --change <change> archive`
- **AND** system SHALL transition from `committing` to `archive` phase

#### Scenario: Git agent failure stops workflow
- **GIVEN** workflow in `committing` phase with git agent running
- **WHEN** preflight check fails or push fails
- **THEN** git agent SHALL report the error
- **AND** SHALL NOT mark phase as `archive`
- **AND** developer SHALL be able to fix and retry

### Requirement: Archive module simplified
After archive split, the archive module SHALL only perform final cleanup: close remaining panes, finalize the OTel trace, and transition to `completed`.

#### Scenario: Archive phase cleanup
- **GIVEN** workflow in `archive` phase
- **WHEN** archive agent runs
- **THEN** SHALL close git agent pane if open
- **AND** SHALL finalize workspace OTel trace
- **AND** SHALL set phase to `completed`
- **AND** SHALL NOT stage, commit, or push
