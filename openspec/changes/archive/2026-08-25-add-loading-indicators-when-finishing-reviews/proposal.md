## Why

Workflow creation and review completion can perform synchronous setup or asynchronous persistence and dispatch work after the user presses Enter or `f`. Without immediate visual feedback, the dashboard appears unresponsive and users cannot tell whether the action was accepted. The TUI should expose progress as soon as these actions begin, while preserving the existing modal and status-message behavior.

## What Changes

- Make the existing workflow-creation progress modal render before the workflow completion callback can block the event loop.
- Reuse the progress-modal presentation for plan-review and developer-review completion, with an operation-specific title/message and visibility for the full save/dispatch operation.
- Keep the review popup open beneath the finishing overlay until completion, then close it through the existing success and error cleanup paths.
- Keep the existing status-bar messages alongside the progress overlay.
- Add focused TUI coverage for the creation yield and both review-finish indicators, including their disappearance after completion.

## Capabilities

### New Capabilities

- `dashboard-operation-progress`: Provides immediate, operation-specific progress feedback while creating a workflow or finishing a plan/developer review.

### Modified Capabilities

- `dashboard-developer-review-popup`: Finishing the developer review visibly enters a progress state before save/dispatch work completes, then closes the popup and clears progress.
- `dashboard-plan-review-comments`: Finishing the plan review visibly enters a progress state before save/dispatch work completes, then closes the popup and clears progress.

## Impact

- TUI components in `agentic-coding/src/tui/dash/ui/ProgressModal.tsx` and `NewWorkflowModal.tsx`.
- Dashboard state, review-finish handlers, modal layering, and cleanup in `agentic-coding/src/tui/dash/App.tsx`.
- Dashboard interaction tests in `agentic-coding/test/dash/newWorkflowModal.test.tsx` and `agentic-coding/test/dash/userActions.test.tsx`.
- No API, workflow-engine, persistence-schema, or dependency changes. Other busy-gated actions remain unchanged; credentials continue to take priority over the review progress overlay.
