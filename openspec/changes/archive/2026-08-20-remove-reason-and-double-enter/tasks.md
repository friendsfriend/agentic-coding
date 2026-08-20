## 1. Repair modal: remove reason requirement

- [x] 1.1 In `src/tui/dash/App.tsx`, remove `repairReason` state and its keystroke handling (letter/space/backspace branches) from the `repair` keymap layer.
- [x] 1.2 In the `repair` keymap layer's Enter branch, dispatch `applyRepair(...)` directly for the selected target without checking or requiring reason text; drop the `"Repair reason is required"` message path.
- [x] 1.3 Update the repair modal's title/help text to no longer mention a reason prompt or "ENTER repairs" contingent on reason (e.g. drop `reason: ...` from the title, keep help hint for Enter = Repair).
- [x] 1.4 Update `applyRepair`/`previewRepair` wiring in `src/tui/dash/data.ts` if the reason parameter needs to become optional at the call site (default to empty string when not provided).

## 2. Engine/CLI: make repair reason optional

- [x] 2.1 In `src/workflow/contracts.ts`, change `operator.repair` parsing so `reason` is validated as an optional/allow-empty bounded string instead of `text(...)` (non-empty), defaulting to `''` when absent.
- [x] 2.2 In `src/workflow/contracts.ts`, relax `parseSnapshot`'s `repaired.reason` validation to allow empty string so previously-empty or newly-empty reasons round-trip.
- [x] 2.3 In `src/workflow/cli.ts`, remove `reason` from `REQUIRED_FLAGS.repair` and update the `repair` usage string so `--reason` is documented as optional.
- [x] 2.4 Confirm `repairWorkflow`/engine `dispatch` for `operator.repair` in `src/workflow/runtime.ts` accepts and stores an empty reason without error.

## 3. Available actions: remove second-Enter confirmation

- [x] 3.1 In `src/tui/dash/App.tsx`'s `completed-picker` keymap layer, remove the `actionConfirmed` gate so that on Enter: if `confirmation === 'reason'` and reason is empty, keep showing `"Action reason is required"`; otherwise dispatch the action immediately (no `"Press Enter again to confirm ..."` intermediate step).
- [x] 3.2 Remove now-unused `actionConfirmed`/`setActionConfirmed` state and its resets (selection change, action-signature change, modal open) if no longer referenced after 3.1.
- [x] 3.3 Update the completed-picker modal title/help text (e.g. drop the `Enter×2` help hint) to reflect single-Enter dispatch.

## 4. Tests

- [x] 4.1 Update/add tests covering repair dispatch with an empty/omitted reason succeeds (engine + CLI level), replacing any test asserting a required-reason failure for repair.
- [x] 4.2 Update/add a dashboard-level test (or App.tsx keymap unit test, matching existing test conventions in `test/workflow-dashboard.test.ts`) verifying an action with `confirmation: 'confirm'` dispatches on the first Enter, and an action with `confirmation: 'reason'` dispatches on the first Enter once reason text is present.
- [x] 4.3 Run the full test suite and fix any other assertions coupled to the removed reason requirement or double-Enter message text.

## 5. Validation

- [x] 5.1 Run `openspec validate remove-reason-and-double-enter --strict` and resolve any reported issues.
