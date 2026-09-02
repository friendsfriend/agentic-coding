# dashboard-developer-review-popup Specification

## Purpose
The developer review changed-files list is rendered directly inside the developer review user-action popup, so review starts immediately in the modal flow, while the diff view remains a separate modal.

## Requirements

### Requirement: Changed files list rendered in the developer review user-action popup
When the workflow reaches the developer review phase, the developer review user action SHALL open a popup that renders the changed-files list directly (file rows with type, path, `+/-` change counts, findings count, and the `Changed Files (N files)` header), instead of a separate full-screen files view or an intermediate `Start developer review` item.

#### Scenario: Popup shows changed files when review is ready
- **WHEN** the workflow enters the developer review phase and the user action popup opens
- **THEN** the popup shows the changed-files list with file rows and change statistics

#### Scenario: Open the diff from the popup
- **WHEN** the user presses Enter on a changed-file row in the popup
- **THEN** the diff for that file opens in the separate diff modal

#### Scenario: Postpone the review
- **WHEN** the user presses Esc in the files popup
- **THEN** the popup closes without dispatching any review finish action

#### Scenario: Finish the review from the popup
- **WHEN** the user presses `f` in the files popup
- **THEN** the review finishes (comments are saved / approval is dispatched) and the popup closes

#### Scenario: Search within the popup
- **WHEN** the user presses `/` in the files popup and types a query
- **THEN** the file list filters by path

### Requirement: Diff view remains a separate modal
The diff view SHALL stay a separate modal opened from the files popup, with its existing navigation and interactions preserved.

#### Scenario: Return from the diff to the files popup
- **WHEN** the user presses Esc in the diff modal
- **THEN** the diff modal closes and the files popup is shown again

#### Scenario: Diff interactions unchanged
- **WHEN** the user interacts with the diff modal (line navigation, file navigation, visual mode, split view, comments, finding selection)
- **THEN** the behavior matches the pre-change diff modal

### Requirement: Finish the review from the popup
When the user finishes the developer review from the files popup, the dashboard SHALL immediately show a finishing-review progress indicator, save comments and dispatch the developer-review outcome, then clear the indicator and close the popup when the operation settles.

#### Scenario: Finish the review from the popup
- **WHEN** the user presses `f` in the files popup
- **THEN** the dashboard immediately shows a finishing-review progress indicator, saves comments and dispatches the developer-review outcome, then clears the indicator and closes the popup when the operation settles

### Requirement: Direct popup open regardless of phase naming
The developer review user action SHALL open the changed-files review popup directly whenever the workflow reaches the developer review step, regardless of whether the dashboard reports the phase as a legacy phase name (`developer-review`) or an engine step id (`core.developer-review`). The generic action-notice modal (a title/prompt-only list with no selectable items) SHALL NOT be shown for this step.

#### Scenario: Engine step id opens the review popup directly
- **WHEN** the workflow reaches the developer review step and the dashboard reports the phase as `core.developer-review`
- **THEN** the changed-files review popup opens directly, without showing the generic "Action required" notice modal

#### Scenario: Legacy phase name keeps opening the review popup directly
- **WHEN** the workflow reaches the developer review step and the dashboard reports the phase as `developer-review`
- **THEN** the changed-files review popup opens directly, as before

#### Scenario: Required user action key is stable across phase naming
- **WHEN** the required developer review user action is computed for either `developer-review` or `core.developer-review`
- **THEN** both produce the same stable action key so the direct-open trigger matches in both cases

### Requirement: Untracked files inside new directories are individually reviewable
The developer-review changed-files list SHALL enumerate every untracked (not-yet-Git-tracked) file individually, including files nested inside newly created directories, rather than collapsing a new directory into a single directory entry. Each enumerated untracked file SHALL be classified as an added file with its `+` change count and SHALL resolve to a valid per-file diff when opened. The `.herdr-workflow` metadata path SHALL remain excluded, and existing tracked-file behavior (modifications, deletions, renames, and root-level untracked files) SHALL be unchanged.

#### Scenario: New file inside a new directory is listed
- **WHEN** the developer-review changed-files list is built for a worktree containing an untracked file inside a directory that does not yet exist in Git (for example `newdir/sub/added.ts`)
- **THEN** that file appears as its own added-file row with its `+` change count, not as a single directory entry

#### Scenario: Diff opens for an untracked file inside a new directory
- **WHEN** the user opens the diff for an untracked file that lives inside a newly created directory
- **THEN** the diff view shows that file's added content instead of an error or empty diff

#### Scenario: Multiple untracked files in a new directory each appear
- **WHEN** a newly created directory contains more than one untracked file
- **THEN** each untracked file appears as its own added-file row

#### Scenario: Existing tracked and metadata behavior is preserved
- **WHEN** the changed-files list is built for a worktree with tracked modifications, tracked deletions, tracked renames, and root-level untracked files, alongside the `.herdr-workflow` metadata directory
- **THEN** tracked changes and root-level untracked files are listed as before and the `.herdr-workflow` metadata path is excluded
