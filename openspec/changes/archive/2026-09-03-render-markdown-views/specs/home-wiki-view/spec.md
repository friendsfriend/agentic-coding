## MODIFIED Requirements

### Requirement: A concept opens in a Markdown note modal
The Wiki view SHALL open a selected concept on Enter in a Markdown modal that renders the note content as formatted terminal output by rendering the whole document as block-level Markdown—so multi-line constructs (lists, tables, block quotes, fenced code blocks) render as formatted blocks rather than raw source lines—with scrolling and a way to return to the tree. Opening a note SHALL load its content on demand rather than eagerly loading every note body during tree construction.

#### Scenario: Enter opens the selected concept
- **WHEN** the user selects a concept row and presses Enter
- **THEN** a Markdown modal opens for that concept
- **AND** the modal renders its current frontmatter/body content as formatted Markdown blocks, with multi-line constructs (lists, tables, block quotes, fenced code blocks) rendered as formatted blocks rather than raw source lines

#### Scenario: Escape returns without submitting
- **WHEN** the user presses Escape in the note modal
- **THEN** the modal closes and the tree is shown again
- **AND** no review workflow is started

#### Scenario: Missing concept is reported
- **WHEN** a concept disappears between tree loading and opening
- **THEN** the modal is not opened with fabricated content
- **AND** the view reports the missing concept and remains navigable

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
- **WHEN** the user adds comments and closes the note modal or changes tabs without pressing `f`
- **THEN** the comments remain only in the active in-memory review session
- **AND** no comment file or wiki concept is written

#### Scenario: Blank comments are rejected
- **WHEN** the user attempts to submit an empty or whitespace-only comment
- **THEN** the view keeps comment mode active and explains that a comment body is required
- **AND** no empty comment is added
