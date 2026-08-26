## MODIFIED Requirements

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
- **THEN** the compact line SHALL replace both arrow segments with a single muted `` glyph
- **AND** it SHALL still show the added, changed, and deleted counts and branch name
