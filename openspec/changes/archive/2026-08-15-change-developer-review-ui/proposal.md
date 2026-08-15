# Proposal: Merge the developer review user action with the changed files view

## Why

When the workflow reaches the `core.developer-review` phase, the dashboard currently requires two separate steps: a generic user-action popup offering `Start developer review` / `Not now`, and — only after that — a full-screen changed-files view. Reviewing therefore needs an extra click and leaves the modal flow entirely (the files view replaces the whole dashboard). The developer asked to merge the two: the changed-files list should be rendered directly inside the popup of the developer review user action, so review starts immediately in the modal flow. The diff view must stay exactly as it is today — a separate modal opened from the files list.

## What Changes

- The developer review user action popup now renders the changed-files list directly (type badge, file path, `+/-` change counts, findings count, and the `Changed Files (N files)` header) instead of a `Start developer review` item.
- The intermediate `Start developer review` item and the separate full-screen files step are removed; `openDeveloperReview()` (the files view) is what the user action opens.
- Selecting a file row in the popup opens the existing `DiffViewModal` unchanged; `Esc` in the diff returns to the files popup.
- All existing review keys keep working in the popup: `j/k` navigate files, `/` filters by path, `f` finishes the review (saves comments / dispatches approval), `Esc` postpones without dispatching.
- `requiredUserActionFor('developer-review')` becomes a trigger-only user action (key/title/prompt, no selectable items).
- `ChangedFilesView` gains an optional embedded mode (`availableLines`) so it can render inside the modal with correct height math; its default full-screen behavior is preserved for any other consumer.
- Tests updated and extended for the new flow.

## Capabilities

### New Capabilities

- `dashboard-developer-review-popup`: Developer review changed-files list rendered inside the developer review user-action popup, with the diff kept in a separate modal.

### Modified Capabilities

- None.

## Impact

- `agentic-coding/src/tui/dash/data.ts`: `RequiredUserActionItem` loses the `review` kind; `requiredUserActionFor('developer-review')` returns a trigger-only action.
- `agentic-coding/src/tui/dash/App.tsx`: entry paths (`openRequiredUserAction`, auto-open effect) open the review popup directly; files view renders as a popup embedding `ChangedFilesView`; diff render unchanged; dead `kind === "review"` branch removed.
- `agentic-coding/src/tui/dash/devenv-ui/components/ChangedFilesView.tsx`: optional `availableLines` embedded mode.
- `agentic-coding/test/dash/data.test.ts` and `agentic-coding/test/dash/userActions.test.tsx`: updated assertions for the merged flow.
- No changes to the workflow engine, persistence, CLI, keymap-layer API, or other phases' user actions. No new dependencies.
