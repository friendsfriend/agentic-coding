## Why

The new workflow modal currently collects a task for standard and quick workflows but skips it for plan-fusion. As a result, users cannot provide the objective that the fusion planners should analyze from the dashboard, even though the workflow runtime already supports task metadata. Plan-fusion should accept the same task input as the other task-driven workflows while retaining its existing workflow behavior.

## What Changes

- Include the task entry step in the plan-fusion path of the new workflow modal.
- Pass the entered task through dashboard startup into the plan-fusion workflow metadata and planner assignments.
- Add regression coverage proving that a task entered for plan-fusion is submitted and forwarded unchanged.
- Preserve direct-apply behavior, which does not use a task field.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-plan-fusion`: Require dashboard-started plan-fusion workflows to accept and preserve a user-defined task/objective from the new workflow modal.

## Impact

Affected UI wizard field selection and dashboard startup input flow in `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx` and related dashboard tests. No workflow engine, API, routing, or external dependency changes are expected; the existing optional task metadata path will be used.
