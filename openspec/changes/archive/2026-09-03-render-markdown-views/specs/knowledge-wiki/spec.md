## MODIFIED Requirements

### Requirement: Wiki review modal
The wiki approval gate SHALL open a review modal listing the concepts the change touched, each showing its change counts, and SHALL open a selected concept in a real diff view comparing its pre-change snapshot with its current content. The diff view SHALL render the concept's Markdown as formatted terminal output by rendering the whole document as block-level Markdown—so multi-line constructs (lists, tables, block quotes, fenced code blocks) render as formatted blocks rather than raw source lines—while preserving the established color semantics of developer review: added content is visibly green, removed content is visibly red, and unchanged context remains distinguishable. The user SHALL be able to navigate the changed content, anchor comments to current-document blocks (top-level Markdown blocks mapped to their current-document source-line ranges) or block ranges, finish the review, and postpone it without dispatching an action.

#### Scenario: Gate opens the concept list directly
- **WHEN** the workflow reaches the wiki approval gate
- **THEN** the wiki review popup opens with the touched-concept list rather than a generic action notice

#### Scenario: Open a concept diff
- **WHEN** the user selects a concept row
- **THEN** the concept opens in a diff view comparing the snapshot (before) against the current (after) content, with the concept's change counts and file navigation context preserved

#### Scenario: Markdown renders as formatted blocks
- **WHEN** a concept contains headings, lists, tables, block quotes, inline code, or fenced code blocks
- **THEN** the diff view renders those constructs with their Markdown presentation as formatted blocks and does not show the source delimiters as the primary rendered content

#### Scenario: Added and removed content is color coded
- **WHEN** the snapshot and current concept differ
- **THEN** added content is rendered with the developer-review green styling, removed content with the developer-review red styling, and context with the normal diff styling

#### Scenario: New and deleted concepts remain reviewable
- **WHEN** a touched concept exists only in the current bundle or only in the snapshot
- **THEN** the diff view shows all current-only content as additions or all snapshot-only content as removals, respectively, without crashing or presenting the concept as unchanged

#### Scenario: Comment on a line
- **WHEN** the user selects a current-document block in the diff view and submits a comment
- **THEN** the comment is anchored to that block's current-concept source-line range and rendered as a comment thread

#### Scenario: Snapshot-only lines are not commentable
- **WHEN** the user selects removed snapshot content or snapshot-only context in the diff view and attempts to comment
- **THEN** the review prevents a writable comment anchor and explains that only current-document content is commentable

#### Scenario: Postpone the review
- **WHEN** the user dismisses the wiki review popup
- **THEN** the popup closes without dispatching any workflow action

#### Scenario: Finish with comments requests changes
- **WHEN** the user finishes the review and comments exist
- **THEN** the comments are persisted for the change and the comments action is dispatched

#### Scenario: Finish without comments approves
- **WHEN** the user finishes the review and no comments exist
- **THEN** the approval action is dispatched
