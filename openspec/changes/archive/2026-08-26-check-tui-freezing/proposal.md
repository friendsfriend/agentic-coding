## Why

The home dashboard's new-workflow wizard can stop responding for several seconds while typing, especially in the task textarea and Change ID field. The task text can also appear in the confirmation summary while the focused textarea remains visually empty, making it unclear whether input was accepted. The wizard needs one reliable input path so typing remains responsive and the editor view stays synchronized with the submitted value.

## What Changes

- Make new-workflow text inputs use a single, non-duplicated keyboard/editing dispatch path.
- Keep the Change ID and other single-line fields responsive while preserving their current validation and Enter/Escape behavior.
- Keep multiline task editing responsive, synchronized with the visible textarea, and compatible with newline insertion and the existing Alt+Enter advance action.
- Add focused regression coverage for rapid text entry, rendered editor content, multiline task submission, and field transitions.
- Add diagnostics or narrowly scoped instrumentation in tests/helpers as needed to distinguish input dispatch/rendering regressions from blocking workflow-start work.

## Capabilities

### New Capabilities

- `tui-input-responsiveness`: Responsive, synchronized text entry in the dashboard's new-workflow wizard.

### Modified Capabilities

- None.

## Impact

- Dashboard wizard UI and its keyboard/keymap integration: `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx`, `agentic-coding/src/tui/dash/Home.tsx`, and any directly required OpenTUI keymap setup.
- New-workflow component tests under `agentic-coding/test/dash/`, with no workflow engine, API, or persisted-state contract changes.
- The existing workflow-start callback remains asynchronous and is not changed beyond ensuring it is not involved in per-keystroke input handling.
