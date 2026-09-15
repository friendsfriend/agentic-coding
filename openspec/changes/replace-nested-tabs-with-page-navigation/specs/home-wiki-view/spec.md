## MODIFIED Requirements

### Requirement: Wiki tab is available in the home shell
The full application SHALL expose Wiki as a repository-independent Home destination and location-picker entry rather than a tab. Wiki SHALL remain available without workflow selection or telemetry data; telemetry visibility restrictions SHALL NOT hide it. Page commands and contextual help SHALL derive from the shared command catalog.

#### Scenario: Home shell shows Wiki destination
- **WHEN** the main application starts in home mode
- **THEN** Home SHALL offer Wiki and selecting it SHALL open the wiki view without repository selection

#### Scenario: Wiki remains available when observability views are restricted
- **WHEN** home mode starts with `--traces-only`
- **THEN** Wiki SHALL remain reachable through Home and the location picker

#### Scenario: Wiki navigation is consistent
- **WHEN** the user leaves Wiki through Back, Parent or the location picker
- **THEN** the shared router SHALL perform the transition and the footer SHALL describe the current page rather than a tab order

### Requirement: Wiki review comments are temporary and line anchored
The note modal SHALL allow the user to create comments anchored to a current-document block (a top-level Markdown block mapped to its current-document source-line range) or a selected range of current-document blocks. The review session SHALL retain multiple comments for one concept and comments across multiple concepts in memory while the home shell is alive, and SHALL not write comment data to the wiki bundle before review submission.

#### Scenario: Add a line comment
- **WHEN** the user selects a current note block, enters comment mode, types non-empty text, and submits it
- **THEN** the comment is stored with the concept identifier, the block's 1-based source-line range, and the comment body
- **AND** the comment is rendered at that block in the note modal

#### Scenario: Add comments across notes
- **WHEN** the user adds comments to two different concepts during one review session
- **THEN** both comments remain available when navigating between those notes
- **AND** each comment retains its own concept and block anchor

#### Scenario: Add a line-range comment
- **WHEN** the user selects a range of current note blocks and submits a comment
- **THEN** the comment stores the 1-based start source line of the first block and end source line of the last block for that concept
- **AND** the range is rendered as one review anchor

#### Scenario: Unsubmitted comments are not persisted
- **WHEN** the user adds comments and closes the note modal or changes pages without pressing `f`
- **THEN** the comments remain only in the active in-memory review session
- **AND** no comment file or wiki concept is written

#### Scenario: Blank comments are rejected
- **WHEN** the user attempts to submit an empty or whitespace-only comment
- **THEN** the view keeps comment mode active and explains that a comment body is required
- **AND** no empty comment is added

### Requirement: Wiki review controls are discoverable
The Wiki view and note modal SHALL expose context-sensitive help for tree navigation, note opening, line navigation, commenting, returning, refreshing, and finishing a review. `f` SHALL be reserved for finishing the current wiki review rather than changing pages or applying an unrelated home action while a note modal is active.

#### Scenario: Note help lists comment controls
- **WHEN** the note modal is open
- **THEN** its help text includes line navigation, comment entry, visual selection, note navigation, Escape, and `f` finish actions

#### Scenario: Finish with no comments does not launch work
- **WHEN** the user presses `f` while the review contains no comments
- **THEN** the view does not start a workflow
- **AND** it displays a notification explaining that at least one comment is required
