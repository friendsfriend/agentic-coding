## ADDED Requirements

### Requirement: Wiki tab is available in the home shell
The home shell SHALL expose a Wiki tab as a peer of the Workflows and observability tabs, and SHALL derive tab cycling, direct selection, and status-bar help from the same ordered tab list. The Wiki tab SHALL be available in home mode without requiring a repository, workflow change, or telemetry data.

#### Scenario: Home shell shows Wiki tab
- **WHEN** the main application is started in home mode
- **THEN** the tab bar contains a `Wiki` tab alongside `Workflows` and the enabled observability tabs
- **AND** selecting or cycling to `Wiki` renders the wiki view without a repository or workflow selection

#### Scenario: Wiki remains available when observability tabs are hidden
- **WHEN** home mode is started with `--traces-only`
- **THEN** the shell hides only the configured observability tabs
- **AND** the `Wiki` tab remains selectable beside the remaining home tabs

#### Scenario: Wiki tab navigation is consistent
- **WHEN** the user cycles tabs or uses a direct tab shortcut from the Wiki view
- **THEN** the shell selects the corresponding tab from the displayed tab order
- **AND** the status bar describes the bindings for the currently displayed tab order

### Requirement: Wiki concepts render as a navigable file tree
The Wiki view SHALL read the centralized bundle through the existing wiki read API and SHALL render concept identifiers as a hierarchical tree of directory and Markdown concept rows. Rows SHALL be sorted deterministically, directory rows SHALL be expandable/collapsible, and reserved bundle files SHALL not appear as concepts.

#### Scenario: Nested concepts form directory rows
- **WHEN** the centralized bundle contains concepts `projects/app/runtime` and `shared/conventions`
- **THEN** the view renders directory rows for the path prefixes and concept rows beneath their corresponding directories
- **AND** the rows appear in stable lexical order

#### Scenario: Directory selection expands and collapses
- **WHEN** the user selects a directory row and presses Enter
- **THEN** the directory toggles between expanded and collapsed state
- **AND** its descendants are included or excluded from keyboard navigation accordingly

#### Scenario: Empty bundle is handled
- **WHEN** the centralized bundle has no readable concepts
- **THEN** the Wiki view renders an explicit empty-state message and remains usable for refresh or quit
- **AND** it does not show `index.md` or `log.md` as concept rows

#### Scenario: Read failures are bounded
- **WHEN** resolving or reading the centralized wiki fails
- **THEN** the Wiki view renders a bounded error state with an actionable diagnostic
- **AND** the shell remains running without throwing an uncaught render error

### Requirement: A concept opens in a Markdown note modal
The Wiki view SHALL open a selected concept on Enter in a Markdown modal that displays the note content with source line numbers, existing Markdown styling, scrolling, and a way to return to the tree. Opening a note SHALL load its content on demand rather than eagerly loading every note body during tree construction.

#### Scenario: Enter opens the selected concept
- **WHEN** the user selects a concept row and presses Enter
- **THEN** a Markdown modal opens for that concept
- **AND** the modal displays its current frontmatter/body content with 1-based source line numbers

#### Scenario: Escape returns without submitting
- **WHEN** the user presses Escape in the note modal
- **THEN** the modal closes and the tree is shown again
- **AND** no review workflow is started

#### Scenario: Missing concept is reported
- **WHEN** a concept disappears between tree loading and opening
- **THEN** the modal is not opened with fabricated content
- **AND** the view reports the missing concept and remains navigable

### Requirement: Wiki review comments are temporary and line anchored
The note modal SHALL allow the user to create comments anchored to a current-document line or selected current-document line range. The review session SHALL retain multiple comments for one concept and comments across multiple concepts in memory while the home shell is alive, and SHALL not write comment data to the wiki bundle before review submission.

#### Scenario: Add a line comment
- **WHEN** the user selects a current note line, enters comment mode, types non-empty text, and submits it
- **THEN** the comment is stored with the concept identifier, the selected 1-based line, and the comment body
- **AND** the comment is rendered at that line in the note modal

#### Scenario: Add comments across notes
- **WHEN** the user adds comments to two different concepts during one review session
- **THEN** both comments remain available when navigating between those notes
- **AND** each comment retains its own concept and line anchor

#### Scenario: Add a line-range comment
- **WHEN** the user selects a visual range of current note lines and submits a comment
- **THEN** the comment stores the range's 1-based start and end lines for that concept
- **AND** the range is rendered as one review anchor

#### Scenario: Unsubmitted comments are not persisted
- **WHEN** the user adds comments and closes the note modal or changes tabs without pressing `f`
- **THEN** the comments remain only in the active in-memory review session
- **AND** no comment file or wiki concept is written

#### Scenario: Blank comments are rejected
- **WHEN** the user attempts to submit an empty or whitespace-only comment
- **THEN** the view keeps comment mode active and explains that a comment body is required
- **AND** no empty comment is added

### Requirement: Wiki review controls are discoverable
The Wiki view and note modal SHALL expose context-sensitive help for tree navigation, note opening, line navigation, commenting, returning, refreshing, and finishing a review. `f` SHALL be reserved for finishing the current wiki review rather than changing tabs or applying an unrelated home action while a note modal is active.

#### Scenario: Note help lists comment controls
- **WHEN** the note modal is open
- **THEN** its help text includes line navigation, comment entry, visual selection, note navigation, Escape, and `f` finish actions

#### Scenario: Finish with no comments does not launch work
- **WHEN** the user presses `f` while the review contains no comments
- **THEN** the view does not start a workflow
- **AND** it displays a notification explaining that at least one comment is required
