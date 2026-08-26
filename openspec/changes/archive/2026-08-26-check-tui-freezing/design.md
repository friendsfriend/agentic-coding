## Context

`NewWorkflowModal` is rendered from `Home` and exposes its own key handler through a high-priority `new-workflow` keymap layer. That layer currently binds printable characters and editing keys for every wizard step. At the same time, the focused OpenTUI `<input>` or `<textarea>` is an editor with its own key handling. Single-line fields update the Solid signal from the modal handler and from the native input event path; the task field additionally calls `TextareaRenderable.handleKeyPress` manually. The task's `onContentChange` callback then reads the editor through a ref while the summary is rendered from the signal. These competing paths can consume a key twice, block the event/render loop, or leave the summary and visible editor out of sync.

OpenTUI 0.4.2 already provides focused-editor behavior and keymap integration helpers for managed textareas. The change is limited to the dashboard wizard and its tests; workflow startup, validation, persistence, and telemetry are not part of per-keystroke handling.

## Goals / Non-Goals

**Goals:**

- Establish one owner for text insertion, deletion, cursor movement, and multiline editing for each focused wizard editor.
- Keep Change ID and other single-line fields responsive during rapid typing and preserve their current submit, back, validation, and optional-field behavior.
- Keep task text visible in the textarea as it is entered, mirror the editor's content into the wizard summary, preserve newlines, and retain Alt+Enter as the advance action.
- Preserve list-step navigation/filtering and the existing confirmation and asynchronous workflow-creation flow.
- Add tests that drive the renderer's focused input path rather than only invoking the modal's private handler, and cover rendering plus submitted values.

**Non-Goals:**

- No changes to workflow definitions, engine state transitions, OpenSpec artifacts, or start-time validation.
- No general rewrite of unrelated dashboard modals or the global keymap architecture.
- No debounced or background workflow-start operation; only input dispatch and editor rendering are in scope.
- No change to the user-visible wizard field order, labels, or submission contract.

## Decisions

### Use the focused OpenTUI editor as the sole text-editing owner

Remove printable-character and ordinary text-editing handling from the wizard path when a native `<input>` or `<textarea>` is focused. Let the focused OpenTUI editor process text, deletion, cursor movement, and paste. Keep the modal/keymap handler responsible only for wizard-level actions that are not text editing: list navigation/filtering, Escape/back, and advancing/confirming where the current editor's submit event does not already provide that boundary. Do not call `handleKeyPress` from application code.

For the textarea, plain Enter remains a newline operation owned by the textarea; Alt+Enter remains the explicit transition to the next wizard step. For single-line inputs, Enter remains submission/advance and must not be duplicated by a second signal mutation. The keymap registration should use the existing OpenTUI focused-editor/managed-textarea facilities or equivalent focused-target gating rather than a broad printable-key binding.

**Alternative considered:** Keep the broad modal layer and suspend native editing. Rejected because the current layer also covers `InputRenderable`, the two editor types have different APIs, and manually replaying events is the mechanism implicated by both the freeze and rendering symptoms.

### Treat editor change values as the synchronization boundary

Update the wizard signal from the value supplied by the OpenTUI input/content-change event. Keep the textarea's internal edit buffer as the source of its displayed text; do not recreate or overwrite it on every Solid signal update. The summary consumes the synchronized signal for display and submission uses the same current value, so the summary cannot advance independently of the editor content.

**Alternative considered:** Make the textarea fully controlled by writing `values().task` back on every render. Rejected because repeatedly replacing an editor buffer can reset cursor/selection state and add render work during rapid typing.

### Keep wizard transitions separate from per-key updates

Centralize field transitions in the existing `next`/`back` flow. A text event updates only the current field; Enter/Alt+Enter invokes the transition exactly once. The creation callback continues to be deferred and guarded by the existing `creating` state, ensuring that workflow-start work cannot run for each keystroke.

**Alternative considered:** Debounce signal updates or workflow callbacks. Rejected because debouncing would hide the dispatch conflict and could lose the value at a transition; no workflow callback should run while typing in the first place.

### Test through focused renderer input and retain targeted handler tests

Extend `newWorkflowModal.test.tsx` with renderer/mock-input scenarios for rapid Change ID typing and multiline task typing. Assert that the visible editor content and summary reflect the same text before advancing, then assert that `onComplete` receives the exact value, including newlines. Keep list navigation tests for workflow selection and add a regression for changing fields without stale characters or delayed updates. Use the existing OpenTUI test renderer and mock input APIs; do not add dependencies or sleep-based timing assertions except bounded frame/flush waits needed to observe a render.

## Risks / Trade-offs

- [Risk] OpenTUI keymap precedence differs between `InputRenderable` and `TextareaRenderable`, so a binding that works for one editor could still double-handle the other. → Mitigation: gate wizard bindings by focused editor/text-entry state, use the package's managed-editor behavior where applicable, and exercise both editor types through renderer-level tests.
- [Risk] Removing broad printable bindings could make list filtering or custom repository path entry lose characters. → Mitigation: retain list/custom-path behavior explicitly, and test both list filter input and the custom repository path if the shared layer is changed.
- [Risk] A textarea transition could submit a stale Solid signal if the final content-change event has not propagated. → Mitigation: read the focused editor's current plain text only at the transition boundary (without replaying its key event), or otherwise update the signal synchronously from the event payload and assert the final value in tests.
- [Risk] Focus may briefly remain on a destroyed editor when switching wizard steps. → Mitigation: preserve the existing focused rendering lifecycle, clear editor references on cleanup/step changes, and verify the first keystroke after each transition goes to the new field.

## Migration Plan

No data or configuration migration is required. Implement the key-dispatch and synchronization changes, update focused component tests, run the repository type-check/lint and focused tests, then run the full required checks. If a regression is found, revert the wizard/keymap changes; existing workflow start behavior and persisted state remain compatible.

## Open Questions

- Confirm during implementation whether the installed OpenTUI keymap version needs the managed-textarea helper registered globally or whether focused native editor handling plus narrower wizard bindings is sufficient. The answer must not reintroduce a second handler for the same key.
- Confirm the renderer-level representation of Alt+Enter in the current terminal/test configuration and cover that representation in the task transition regression test.
