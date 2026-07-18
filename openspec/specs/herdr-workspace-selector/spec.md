# herdr-workspace-selector Specification

## Purpose
TBD - created by archiving change add-current-working-dir-to-project-options. Update Purpose after archive.
## Requirements
### Requirement: Current‑directory quick‑select in workspace project selector
The system SHALL show the shell's current working directory as a selectable option in every project selector used to create a new Herdr workspace.

#### Scenario: Dashboard modal shows CWD between projects and custom path
- **GIVEN** the dashboard new‑workflow modal is open
- **WHEN** the project list is displayed
- **THEN** the list SHALL contain an entry labeled `Current Directory (<basename>)` positioned between the discovered‑project section and the `Custom path…` option
- **AND** selecting that entry SHALL pre‑fill the repository path with `process.cwd()`

#### Scenario: Pi extension select shows CWD in project list
- **GIVEN** the `implementation` command select list is displayed
- **WHEN** the project list is shown
- **THEN** the list SHALL contain an entry labeled `Current Directory (<basename>)`
- **AND** selecting that entry SHALL use `process.cwd()` as the repository path

#### Scenario: Basename reflects current directory
- **WHEN** the shell current working directory is `/some/path/my-project`
- **THEN** the selector entry SHALL display `Current Directory (my-project)`
- **AND** when the shell current working directory changes, the entry SHALL update accordingly on next invocation

