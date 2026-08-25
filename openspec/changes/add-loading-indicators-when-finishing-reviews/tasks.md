## 1. Progress Modal and Workflow Creation

- [ ] 1.1 Add an optional title prop to `src/tui/dash/ui/ProgressModal.tsx`, defaulting to `Creating workflow`, while preserving the existing message layout.
- [ ] 1.2 Update `NewWorkflowModal.submit()` to set the creation state and yield one macrotask before invoking `onComplete`, while retaining the existing input guard and `finally` cleanup.

## 2. Review-Finish Progress State

- [ ] 2.1 Add a dedicated review-finishing signal and operation-specific message handling to `src/tui/dash/App.tsx`, set it for valid plan/developer finishes, and clear it on every completion and error path.
- [ ] 2.2 Yield one macrotask after entering the review-finishing state so the indicator can paint before comment collection, persistence, or dispatch work begins.
- [ ] 2.3 Render the configurable progress modal above the open review views while review finishing is active, without changing unrelated busy-gated operations, credential handling, or status messages.

## 3. TUI Verification

- [ ] 3.1 Add NewWorkflowModal coverage proving the creation indicator renders before a controlled completion callback proceeds and clears after the callback settles.
- [ ] 3.2 Extend dashboard interaction coverage for plan-review finish to assert the finishing indicator during deferred completion and its removal after the review closes.
- [ ] 3.3 Extend dashboard interaction coverage for developer-review finish to assert the finishing indicator during deferred completion and its removal after the review closes.
- [ ] 3.4 Run the focused dashboard tests and the repository type-check/lint checks, resolving any timing or modal-stacking regressions.
