# dashboard-plan-review-comments Specification

## Purpose
Plan approval is reviewed through a modal flow that mirrors the developer review: an artifact list popup, a separate markdown view for each artifact, and line-anchored comments that decide between approval and planner feedback.

## Requirements

### Requirement: Plan review popup lists OpenSpec artifacts
When the workflow reaches the plan approval gate, the plan review popup SHALL open and list all OpenSpec artifacts created by the planner (proposal, design, tasks, and every delta spec) instead of the generic action picker.

#### Scenario: Popup shows the artifact list
- **WHEN** the workflow enters the plan approval gate and the review popup opens
- **THEN** the popup lists every OpenSpec artifact of the change with its file name

#### Scenario: Postpone the review
- **WHEN** the user presses Esc in the plan review popup
- **THEN** the popup closes without dispatching any workflow action

#### Scenario: Search the artifact list
- **WHEN** the user presses `/` in the plan review popup and types a query
- **THEN** the artifact list filters by path

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

### Requirement: Finish checks comments and dispatches the matching action
Finishing the plan review SHALL immediately show a finishing-review progress indicator while it checks comments, persists them when applicable, and dispatches the matching action. Without comments the workflow SHALL dispatch the plan approval action so the worker starts implementation; with comments the workflow SHALL save the comments and dispatch the review-comments action with a bounded payload so the planner receives the feedback. The indicator SHALL clear and the review SHALL close when the operation settles.

#### Scenario: Finish without comments approves the plan
- **WHEN** the user presses `f` in the plan review and no comments exist
- **THEN** the review shows the finishing-review progress indicator, dispatches the plan approval action, then closes and clears the indicator

#### Scenario: Finish with comments sends feedback to the planner
- **WHEN** the user presses `f` in the plan review and comments exist
- **THEN** the review shows the finishing-review progress indicator, closes after the comments are persisted and the review-comments action is dispatched, and clears the indicator

#### Scenario: Comments persist for the review round
- **WHEN** the plan review is finished with comments
- **THEN** the comments are written to `reviews/plan-review.json` under the workflow's change directory while the finishing-review progress indicator remains visible

### Requirement: Demo dashboard exercises the plan review flow
The demo dashboard SHALL provide plan artifacts and markdown content so the plan review popup and markdown modal are exercisable without a real workflow.

#### Scenario: Demo opens the plan review popup
- **WHEN** the demo dashboard reaches the plan approval phase and the review opens
- **THEN** the popup shows demo artifacts and the markdown modal shows demo artifact content

### Requirement: Direct popup open regardless of phase naming
The plan review user action SHALL open the artifact-list review popup directly whenever the workflow reaches the plan approval gate, regardless of whether the dashboard reports the phase as a legacy phase name (`proposed`) or an engine step id (`core.plan-approval`). The generic action-notice modal (a title/prompt-only list with no selectable items) SHALL NOT be shown for this gate.

#### Scenario: Engine step id opens the review popup directly
- **WHEN** the workflow reaches the plan approval gate and the dashboard reports the phase as `core.plan-approval`
- **THEN** the artifact-list review popup opens directly, without showing the generic "Action required" notice modal

#### Scenario: Legacy phase name keeps opening the review popup directly
- **WHEN** the workflow reaches the plan approval gate and the dashboard reports the phase as `proposed`
- **THEN** the artifact-list review popup opens directly, as before

#### Scenario: Required user action key is stable across phase naming
- **WHEN** the required plan review user action is computed for either `proposed` or `core.plan-approval`
- **THEN** both produce the same stable action key so the direct-open trigger matches in both cases
