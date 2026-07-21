## ADDED Requirements

### Requirement: Direct-apply archives before git operations
The system SHALL sequence the archive module before the git-operations module in the direct-apply workflow so the OpenSpec archive move is committed and pushed by the git role, not left un-archived.

#### Scenario: Direct-apply module order places archive before git-operations
- **GIVEN** the direct-apply workflow type definition
- **WHEN** system reads `WORKFLOW_TYPES["direct-apply"]`
- **THEN** module list SHALL be `["apply-verify", "developer-approval", "archive", "git-operations"]`
- **AND** `archive` SHALL appear before `git-operations`

#### Scenario: Archive move is staged into the pushed commit
- **GIVEN** an approved, verified direct-apply change with a directory under `openspec/changes/<change>/`
- **WHEN** the workflow advances past developer approval
- **THEN** the archive role SHALL run `openspec archive` to move the change directory into `openspec/changes/archive/` before the git role runs
- **AND** the git role SHALL stage that archive move together with the implementation changes into a single commit
- **AND** the git role SHALL push a branch where the change directory is already archived

#### Scenario: Direct-apply phase flow after developer approval
- **GIVEN** a direct-apply workflow in `developer-review` phase with approval granted
- **WHEN** the workflow advances
- **THEN** it SHALL transition `developer-review → archive → committing → completed`
- **AND** the git role SHALL NOT run until the archive role has left a clean, stageable tree

### Requirement: Module registry orders archive before git-operations
The system SHALL define the archive module to exit into the git-operations entry phase.

#### Scenario: Archive module exits to committing
- **GIVEN** the workflow module registry
- **WHEN** system reads `WORKFLOW_MODULES["archive"]`
- **THEN** its `exit` SHALL be `"committing"`
- **AND** `WORKFLOW_MODULES["git-operations"]["exit"]` SHALL be `"completed"`
- **AND** `git-operations` SHALL be the final module in every workflow type that includes it
