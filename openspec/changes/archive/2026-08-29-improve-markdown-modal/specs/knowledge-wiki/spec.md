## MODIFIED Requirements

### Requirement: Wiki review modal
The wiki approval gate SHALL open a review modal listing the concepts the change touched, each showing its change counts, and SHALL open a selected concept in a real diff view comparing its pre-change snapshot with its current content. The diff view SHALL use the same selectable unified/split review presentation and established color semantics as developer review: added content is visibly green, removed content is visibly red, and unchanged context remains distinguishable. The user SHALL be able to navigate the changed lines, anchor comments to current-document lines or line ranges, finish the review, and postpone it without dispatching an action.

#### Scenario: Gate opens the concept list directly
- **WHEN** the workflow reaches the wiki approval gate
- **THEN** the wiki review popup opens with the touched-concept list rather than a generic action notice

#### Scenario: Open a concept diff
- **WHEN** the user selects a concept row
- **THEN** the concept opens in a diff view comparing the snapshot (before) against the current (after) content, with the concept's change counts and file navigation context preserved

#### Scenario: Added and removed content is color coded
- **WHEN** the snapshot and current concept differ
- **THEN** added lines are rendered with the developer-review green styling, removed lines with the developer-review red styling, and context lines with the normal diff styling

#### Scenario: New and deleted concepts remain reviewable
- **WHEN** a touched concept exists only in the current bundle or only in the snapshot
- **THEN** the diff view shows all current-only lines as additions or all snapshot-only lines as removals, respectively, without crashing or presenting the concept as unchanged

#### Scenario: Comment on a line
- **WHEN** the user selects a current-document line in the diff view and submits a comment
- **THEN** the comment is anchored to that current concept line and rendered as a comment thread

#### Scenario: Snapshot-only lines are not commentable
- **WHEN** the user selects a removed snapshot line or snapshot-only context in the diff view and attempts to comment
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
