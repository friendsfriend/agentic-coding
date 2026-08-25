## 1. Plan-fusion modal task input

- [x] 1.1 Update `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx` so `plan-fusion` uses the task-driven wizard field sequence shared by standard and quick, while direct-apply remains on the base sequence.
- [x] 1.2 Confirm the existing modal task textarea, summary, and navigation preserve multiline task text and place task before checkout mode for plan-fusion.

## 2. Regression coverage

- [x] 2.1 Extend `agentic-coding/test/dash/newWorkflowModal.test.tsx` to enter a representative task in the plan-fusion flow and assert the submitted `workflowType` and task value.
- [x] 2.2 Extend focused dashboard startup argument coverage, if needed, to assert a plan-fusion task is forwarded unchanged through `startArgs`/startup metadata, and retain coverage that direct-apply omits the task step.

## 3. Validation

- [x] 3.1 Run the focused dashboard modal and data tests, then run `bun run type-check` and `bun run lint` from `agentic-coding/`.
