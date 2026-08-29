## MODIFIED Requirements

### Requirement: Markdown view modal with line-anchored comments
The plan review popup SHALL open each artifact in a separate Markdown-rendered modal. The modal SHALL render supported Markdown structure—including headings, paragraphs, emphasis, links, lists, block quotes, horizontal rules, inline code, and fenced code blocks—instead of exposing Markdown delimiter characters as ordinary document text. It SHALL retain a selectable source-line model so the user can navigate, scroll, select a line or line range, and anchor review comments to the corresponding source lines.

#### Scenario: Open an artifact in the markdown modal
- **WHEN** the user presses Enter on an artifact row in the plan review popup
- **THEN** the artifact content opens in the separate modal with Markdown headings and other supported formatting rendered for terminal display

#### Scenario: Render Markdown blocks and inline styles
- **WHEN** an artifact contains headings, emphasis, links, lists, block quotes, horizontal rules, inline code, or a fenced code block
- **THEN** the modal presents those constructs with their Markdown presentation and does not show the source delimiters as the primary rendered content

#### Scenario: Select a rendered source line
- **WHEN** the user navigates or clicks a rendered document line
- **THEN** the corresponding source line is selected and remains available for comment anchoring even when rendering changes its visual styling or height

#### Scenario: Comment on a line
- **WHEN** the user selects a line in the Markdown modal and presses `c`
- **THEN** a comment input appears and the submitted comment is anchored to the selected source line and rendered inline as a comment thread

#### Scenario: Comment on a visual range
- **WHEN** the user selects a source-line range in the Markdown modal and submits a comment
- **THEN** the comment carries the range start and end source lines

#### Scenario: Cycle comments
- **WHEN** the user presses `n` or `N` in the Markdown modal
- **THEN** the selection jumps to the next or previous commented source line

#### Scenario: Return to the artifact list
- **WHEN** the user presses Esc in the Markdown modal
- **THEN** the Markdown modal closes and the plan review popup is shown again
