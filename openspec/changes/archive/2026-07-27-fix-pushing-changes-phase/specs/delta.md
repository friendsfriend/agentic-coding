# Delta specs for fix-pushing-changes-phase

## Changes to existing specs

These scenarios refine the `git-operations-module` spec and add new scenarios.

## New requirements

### Requirement: State persistence atomicity
`save_state` SHALL write state atomically so a concurrent reader never sees a partially-written file.

#### Scenario: Concurrent read during write shows old or new state, never partial
- **GIVEN** `save_state` writes state.json  
- **WHEN** a reader reads the file while the write is in progress  
- **THEN** the reader SHALL see either the complete previous content or complete new content  
- **AND** SHALL NOT see truncated or invalid JSON  

### Requirement: Rollback safety after git operations
When `_start_git_operations` encounters an error after `_complete_git_operations` has already transitioned the phase to `completed`, the system SHALL NOT restore the previous phase. The commit and push have already succeeded — the phase must stay `completed`.

#### Scenario: finalize_workspace_trace failure does not roll back completed
- **GIVEN** `_start_git_operations` has run git add, commit, push successfully  
- **AND** `_complete_git_operations` has persisted phase `completed` via `change_phase`  
- **WHEN** a subsequent step (e.g. `finalize_workspace_trace`) fails  
- **THEN** the exception handler SHALL NOT restore the phase to `archive`  
- **AND** state.json SHALL remain `completed`  

#### Scenario: Pre-git failure still rolls back to archive
- **GIVEN** `_start_git_operations` has only persisted `committing` phase  
- **WHEN** git add or commit or push fails  
- **THEN** the exception handler SHALL restore the phase to `archive`  
- **AND** the caller may retry  

### Requirement: Dashboard recovery for stuck committing phase
The dashboard SHALL provide an Enter-key gate action for `committing` and `archive` phases so a developer can manually advance the workflow.

#### Scenario: Enter on committing runs archive command
- **GIVEN** dashboard displays a workflow in `committing` phase with no active agents  
- **WHEN** developer presses Enter  
- **THEN** dashboard SHALL invoke `herdr-workflow archive`  
- **AND** `cmd_archive` SHALL handle the `committing` phase by completing the flow  

#### Scenario: cmd_archive handles committing with clean tree
- **GIVEN** a workflow in `committing` phase where git operations already succeeded  
- **WHEN** `cmd_archive` runs `_complete_git_operations`  
- **AND** `_complete_git_operations` raises `SystemExit` because the tree is clean (already committed)  
- **THEN** `cmd_archive` SHALL still transition the phase to `completed`  
- **AND** SHALL NOT keep the phase at `committing`  
- **AND** SHALL NOT leave the phase stuck at `archive` after retry
