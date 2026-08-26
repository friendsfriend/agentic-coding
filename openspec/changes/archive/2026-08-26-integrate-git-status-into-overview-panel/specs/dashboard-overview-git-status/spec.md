## ADDED Requirements

### Requirement: Overview displays structured Git status
The dashboard's primary Change/overview panel SHALL display the workflow worktree's Git status as distinct changed-file, new-file, and deleted-file counts, together with commits ahead of and behind the configured upstream relative to HEAD.

#### Scenario: Overview shows file and divergence counts
- **WHEN** the workflow worktree is a Git repository with modified, untracked, deleted, or otherwise classified paths and a usable upstream
- **THEN** the Change/overview panel SHALL show separate changed, new, and deleted file counts
- **AND** it SHALL show separate ahead and behind commit counts
- **AND** each path SHALL contribute to at most one file-count category

#### Scenario: Clean worktree with upstream
- **WHEN** the worktree has no changed, new, or deleted files and is equal to its upstream
- **THEN** the overview SHALL show zero for changed, new, deleted, ahead, and behind counts
- **AND** it SHALL not replace the count summary with only a clean/dirty label

#### Scenario: Worktree has no usable upstream
- **WHEN** the worktree has no configured upstream, or its configured upstream is gone
- **THEN** the overview SHALL still show changed, new, and deleted file counts
- **AND** it SHALL explicitly indicate that ahead/behind counts are unavailable because no usable upstream exists
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
