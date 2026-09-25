# Proposal

## Why

The contextual "New workflow" form classifies a workflow type as task-driven or
change-selecting through a fixed `TASK_TYPES` set in
`src/tui/dash/ui/NewWorkflowModal.tsx`. `openspec-jev` is absent from that set,
so the wizard silently drops the task step for it and collects neither the
user's task text nor a change selection. `openspec-jev` runs the same plan-first
graph as `openspec-full` and needs the same task input to steer the planner, so
the omission makes the JEV launch unusable for its intended purpose.

## What Changes

- Treat `openspec-jev` as a task-driven workflow in the new-workflow form, so
  the wizard shows and submits the same task step it shows for `openspec-full`.
- Keep the existing field order and checkout behavior for `openspec-jev`
  (`workflowType`, preset, ticket, workflow id, task, mode) so it matches the
  standard OpenSpec flow instead of introducing a JEV-specific layout.
- Leave every other workflow type's field set unchanged, including
  `openspec-jev-apply` (its existing-change selection gap is tracked separately,
  not fixed here).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `contextual-workflow-launch`: the form must expose the task input for every
  registry workflow type that drives the planner from a user task, explicitly
  including `openspec-jev`.

## Impact

- `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx` — the `TASK_TYPES`
  classification that decides whether the task step is rendered and submitted.
- `agentic-coding/test/dash/newWorkflowModal.test.tsx` — add coverage that
  `openspec-jev` renders and submits the task step, mirroring the existing
  `openspec-apply` and `openspec-fusion-full` cases.
- No change to the workflow engine, registry, CLI start validation, or any
  other workflow type.
