## ADDED Requirements

### Requirement: Overview displays selected workspace Git status
The workspace overview SHALL show a Git status panel for the selected workflow workspace. The panel SHALL identify the current branch and display distinct counts for modified/changed files, added files, deleted files, commits ahead of the upstream branch, and commits behind the upstream branch.

#### Scenario: Selected workspace has working-tree and upstream changes
- **GIVEN** the selected workflow has a reachable Git worktree on a branch with an upstream
- **AND** the worktree has two modified files, one added file, and one deleted file
- **AND** the branch is three commits ahead and one commit behind its upstream
- **WHEN** the workspace overview renders
- **THEN** the Git status panel SHALL show changed `2`, added `1`, deleted `1`, ahead `3`, and behind `1`
- **AND** the panel SHALL show the worktree's branch name

#### Scenario: Selected workspace is clean
- **GIVEN** the selected workflow has a reachable Git worktree with no file changes
- **AND** its branch has a reachable upstream
- **WHEN** the workspace overview renders
- **THEN** the Git status panel SHALL show changed `0`, added `0`, and deleted `0`
- **AND** the panel SHALL show the calculated ahead and behind counts, including zero values

#### Scenario: Selected workspace has no upstream
- **GIVEN** the selected workflow has a reachable Git worktree on a branch without an upstream
- **WHEN** the workspace overview renders
- **THEN** the Git status panel SHALL show the branch name and working-tree file counts
- **AND** it SHALL explicitly show that ahead/behind counts are unavailable because no upstream is configured

#### Scenario: Git status cannot be read
- **GIVEN** the selected workflow worktree is missing, inaccessible, or not a Git worktree
- **WHEN** the workspace overview renders
- **THEN** the Git status panel SHALL show an unavailable state and a bounded diagnostic
- **AND** the workspace list SHALL remain usable

### Requirement: Overview refreshes Git status
The workspace overview SHALL refresh each workflow's Git status when its existing workspace refresh runs, without persisting Git metrics in workflow state.

#### Scenario: Refresh observes changed working-tree counts
- **GIVEN** a workspace overview is showing Git status for a selected workflow
- **WHEN** a tracked file is modified and the overview refresh is triggered
- **THEN** the Git status panel SHALL display the updated changed-file count
- **AND** the panel SHALL leave the workflow state and repository contents unchanged

### Requirement: Overview opens changed files with G
The workspace overview SHALL bind `G` to opening the selected workflow's changed-files view. The view SHALL reuse the existing changed-file list and diff interaction used by the dashboard Git panel, including file selection, Enter to open a diff, and Escape to return to the overview.

#### Scenario: G opens changed files for the selected workspace
- **GIVEN** a selected workflow with changed files
- **WHEN** the user presses `G` in the workspace overview
- **THEN** a changed-files modal SHALL open for that workflow's worktree
- **AND** it SHALL display the existing changed-file view with file paths and line-change statistics

#### Scenario: Changed-file interaction opens a diff
- **GIVEN** the overview changed-files modal is open with a file selected
- **WHEN** the user presses Enter
- **THEN** the existing diff view SHALL open for the selected file
- **AND** pressing Escape SHALL return to the changed-files modal without losing its selection

#### Scenario: G has no selected workspace
- **GIVEN** the workspace overview has no selected workflow
- **WHEN** the user presses `G`
- **THEN** no changed-files modal SHALL open
- **AND** the overview SHALL remain usable

#### Scenario: G finds no changed files
- **GIVEN** a selected workflow has no changed files
- **WHEN** the user presses `G`
- **THEN** the changed-files modal SHALL open with the existing empty state
- **AND** it SHALL not launch an external Git UI or alter workflow state
