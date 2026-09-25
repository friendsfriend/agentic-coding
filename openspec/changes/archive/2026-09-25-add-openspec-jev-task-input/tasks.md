# Tasks

## 1. Restore the JEV task step

- [x] 1.1 In `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx`, add `openspec-jev` to the `TASK_TYPES` classification that decides whether the wizard renders the task step, and update its doc comment to name the task-driven versus change-selecting branches accurately. Verify by running `bun run type-check` in `agentic-coding/` with no errors.
- [x] 1.2 Verify the wizard field order for `openspec-jev` is `workflowType`, preset, ticket, workflow id, task, mode by rendering the form in a test (see 1.3) and asserting the task step appears before the checkout-mode step.
- [x] 1.3 Add a focused test to `agentic-coding/test/dash/newWorkflowModal.test.tsx` that selects the `openspec-jev` workflow type, advances through preset/ticket/workflow id, types task text, and asserts the form renders the task input and submits a launch input with `workflowType: "openspec-jev"` and the entered `task`. Run it with `bun test test/dash/newWorkflowModal.test.tsx` from `agentic-coding/` and confirm it passes.
- [x] 1.4 Re-run the existing `openspec-apply` case in the same test file to confirm change-selecting workflows still omit the task step and submit no task.

## 2. Validation

- [x] 2.1 From `agentic-coding/`, run `bun run lint` and confirm zero diagnostics, then run `bun run type-check` and confirm no type errors.
- [x] 2.2 Open the TUI new-workflow form for a repository target, select `Openspec (JEV)`, and confirm the task step is present and that the footer and `?` help modal keybind catalogs are unchanged from before this change.
- [x] 2.3 Run `openspec validate "add-openspec-jev-task-input" --strict` from the repository root and confirm the change validates.
