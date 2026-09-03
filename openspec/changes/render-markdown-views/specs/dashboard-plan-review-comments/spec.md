## MODIFIED Requirements

### Requirement: Markdown view modal with line-anchored comments
The plan review popup SHALL open each artifact in a separate Markdown-rendered modal. The modal SHALL render supported Markdown structure—including headings, paragraphs, emphasis, links, lists, block quotes, horizontal rules, inline code, and fenced code blocks—as formatted terminal output by rendering the whole artifact document as block-level Markdown, instead of exposing Markdown delimiter characters as ordinary document text and instead of rendering each source line as an isolated document. The modal SHALL present the artifact as a sequence of selectable top-level Markdown blocks (for example a heading, a paragraph, a list, a table, a block quote, or a fenced code block), each mapped to the range of source lines it was parsed from, so the user can navigate, scroll, select a block or block range, and anchor review comments to the corresponding source-line ranges.

#### Scenario: Open an artifact in the markdown modal
- **WHEN** the user presses Enter on an artifact row in the plan review popup
- **THEN** the artifact content opens in the separate modal with Markdown headings and other supported formatting rendered for terminal display

#### Scenario: Render Markdown blocks and inline styles
- **WHEN** an artifact contains headings, emphasis, links, lists, block quotes, horizontal rules, inline code, or a fenced code block
- **THEN** the modal presents those constructs with their Markdown presentation and does not show the source delimiters as the primary rendered content
- **AND** a construct that spans multiple source lines (such as a list, table, block quote, or fenced code block) is rendered as one formatted block rather than one raw line at a time

#### Scenario: Select a rendered source line
- **WHEN** the user navigates or clicks a rendered Markdown block
- **THEN** that block is selected and its source-line range remains available for comment anchoring even when rendering changes its visual styling or height

#### Scenario: Comment on a line
- **WHEN** the user selects a block in the Markdown modal and presses `c`
- **THEN** a comment input appears and the submitted comment is anchored to the selected block's source-line range and rendered inline as a comment thread

#### Scenario: Comment on a visual range
- **WHEN** the user selects a range of blocks in the Markdown modal and submits a comment
- **THEN** the comment carries the start source line of the first selected block and the end source line of the last selected block

#### Scenario: Cycle comments
- **WHEN** the user presses `n` or `N` in the Markdown modal
- **THEN** the selection jumps to the next or previous commented block

#### Scenario: Return to the artifact list
- **WHEN** the user presses Esc in the Markdown modal
- **THEN** the Markdown modal closes and the plan review popup is shown again
