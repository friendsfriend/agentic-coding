## 1. Unify wizard text-input dispatch

- [ ] 1.1 Narrow the home `new-workflow` keymap bindings or add focused-editor gating so printable characters and ordinary editing keys are not handled by both the modal handler and the focused OpenTUI editor; preserve list navigation/filtering, custom repository entry, Escape, and wizard-level transitions.
- [ ] 1.2 Refactor `NewWorkflowModal` text-field handling so single-line inputs use their native OpenTUI input events, the task textarea uses its native edit buffer without application-level `handleKeyPress` replay, and each Enter/Alt+Enter transition executes once.
- [ ] 1.3 Synchronize wizard state from the OpenTUI input/content-change value while retaining the textarea edit buffer and focus across signal updates; ensure the summary and final submission use the same current value, including multiline task text.
- [ ] 1.4 Verify the installed OpenTUI 0.4.2 focused-editor/managed-textarea behavior and apply the minimal required keymap integration, without introducing a new dependency or changing workflow-engine startup code.

## 2. Add focused regression coverage

- [ ] 2.1 Update `agentic-coding/test/dash/newWorkflowModal.test.tsx` to drive Change ID typing through the test renderer's focused input path and assert rapid text appears in both the editor frame and summary exactly once.
- [ ] 2.2 Add renderer-level task textarea coverage for visible typing, newline insertion, summary synchronization, exact multiline submission, and the existing Alt+Enter advance behavior.
- [ ] 2.3 Add or retain transition regressions proving single-line Enter advances once, editing does not leak into another field, list/filter and custom repository input still work, and workflow completion is not invoked during typing.
- [ ] 2.4 Preserve the creation-progress regression so the callback starts only after confirmation and the progress modal behavior remains unchanged while completion is unresolved.

## 3. Validate the change

- [ ] 3.1 Run the focused new-workflow modal tests and inspect rendered frames/payload assertions for both reported symptoms.
- [ ] 3.2 Run `bun run type-check` and `bun run lint` from `agentic-coding/`, then resolve any diagnostics introduced by the input/keymap changes.
- [ ] 3.3 Run the repository's required test suite and confirm no workflow engine, API, or persisted-state behavior changed.
