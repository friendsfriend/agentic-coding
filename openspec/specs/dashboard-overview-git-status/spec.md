# dashboard-overview-git-status Specification

## Purpose
TBD - created by archiving change integrate-git-status-into-overview-panel. Update Purpose after archive.
## Requirements
### Requirement: Overview displays structured Git status
The dashboard's primary Change/overview panel SHALL display the workflow worktree's Git status as a single compact line containing distinct added, changed, and deleted file counts together with commits ahead of and behind the configured upstream relative to HEAD, followed by the branch name.

#### Scenario: Overview shows file and divergence counts
- **WHEN** the workflow worktree is a Git repository with modified, untracked, deleted, or otherwise classified paths and a usable upstream
- **THEN** the Change/overview panel SHALL show the added, changed, and deleted file counts as separate segments on one line
- **AND** it SHALL show the ahead and behind commit counts as separate segments on that same line
- **AND** each path SHALL contribute to at most one file-count category

#### Scenario: Clean worktree with upstream
- **WHEN** the worktree has no changed, new, or deleted files and is equal to its upstream
- **THEN** the compact line SHALL show zero for added, changed, deleted, ahead, and behind counts
- **AND** it SHALL not replace the count summary with only a clean/dirty label

#### Scenario: Worktree has no usable upstream
- **WHEN** the worktree has no configured upstream, or its configured upstream is gone
- **THEN** the compact line SHALL still show the added, changed, and deleted file counts
- **AND** it SHALL explicitly indicate via a single inline `no upstream` segment that divergence counts are unavailable
- **AND** it SHALL not present unavailable divergence as zero

### Requirement: Git status inspection is safe and consistent
The dashboard SHALL obtain the overview Git status from the existing best-effort worktree inspection, SHALL exclude `.herdr-workflow` metadata from file counts, and SHALL render a bounded diagnostic when the worktree cannot be inspected without preventing the rest of the dashboard from loading.

#### Scenario: Workflow metadata is ignored
- **WHEN** only files under `.herdr-workflow` are changed in the worktree
- **THEN** the overview SHALL report zero changed, new, and deleted files
- **AND** it SHALL continue to report usable branch divergence when available

#### Scenario: Worktree is unavailable
- **WHEN** the workflow worktree is missing or is not a Git repository
- **THEN** the dashboard SHALL remain renderable
- **AND** the overview SHALL show a bounded unavailable diagnostic instead of throwing

#### Scenario: Status refreshes with dashboard data
- **WHEN** the dashboard is manually refreshed or an existing watched dashboard directory triggers a refresh
- **THEN** the overview SHALL render a newly inspected Git status snapshot
- **AND** it SHALL not require a workflow-state mutation to update the display

### Requirement: Overview renders git status as a single compact line
The dashboard's primary Change/overview panel SHALL render the worktree's git status as one horizontal line in the order: added count prefixed `+`, changed count prefixed `*`, deleted count prefixed `-`, ahead count prefixed `↑`, behind count prefixed `↓`, and the branch name last. The line SHALL use distinct colors per segment: added green, changed yellow, deleted red, ahead green, behind green, branch in regular secondary text.

#### Scenario: Compact line shows all counts and the branch
- **WHEN** the workflow worktree is a Git repository with a usable upstream
- **THEN** the overview panel SHALL show one status line containing `+<added>*<changed>-<deleted>` followed by `↑<ahead>` and `↓<behind>` and ending with the branch name
- **AND** each count SHALL be rendered even when zero
- **AND** the added segment SHALL be green, the changed segment yellow, the deleted segment red, the ahead and behind segments green, and the branch name regular secondary text

#### Scenario: Line stays bounded at narrow widths
- **WHEN** the overview panel is rendered at a narrow terminal width
- **THEN** the compact status line SHALL be clipped to the panel width instead of wrapping onto multiple lines

#### Scenario: Worktree has no usable upstream
- **WHEN** the worktree has no configured upstream, or its configured upstream is gone
- **THEN** the compact line SHALL replace both arrow segments with a single muted `no upstream` indication
- **AND** it SHALL still show the added, changed, deleted counts and branch name

