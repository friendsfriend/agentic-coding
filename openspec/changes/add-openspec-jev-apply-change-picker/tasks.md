# Tasks

## 1. Share the existing-change classification

- [ ] 1.1 In `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx`, introduce a single existing-change workflow-type set containing `openspec-apply` and `openspec-jev-apply`, and replace the three `workflowType === "openspec-apply"` comparisons (change prefetch effect, workflow-id completion choices, `listStep()`) with membership in that set. Verify with `bun run type-check` in `agentic-coding/` that no type errors are introduced.
- [ ] 1.2 Add a focused test to `agentic-coding/test/dash/newWorkflowModal.test.tsx` that selects `openspec-jev-apply` in a temporary repository containing an OpenSpec change, asserts the change id renders as a selectable list choice, selects it, and submits a launch input with `workflowType: "openspec-jev-apply"` and that change id as the workflow id. Run `bun test test/dash/newWorkflowModal.test.tsx` from `agentic-coding/` and confirm it passes.
- [ ] 1.3 Confirm in the same test file that the existing `openspec-apply` change-picker case still passes and that a non-apply type retains the free-text workflow-id input.

## 2. Validation

- [ ] 2.1 From `agentic-coding/`, run `bun run lint` and confirm zero diagnostics, then run `bun run type-check` and confirm no type errors.
- [ ] 2.2 Open the TUI new-workflow form for a repository target, select `Openspec apply (JEV)`, and confirm the workflow-id step lists the repository's OpenSpec changes.
- [ ] 2.3 Run `openspec validate "add-openspec-jev-apply-change-picker" --strict` from the repository root and confirm the change validates.
