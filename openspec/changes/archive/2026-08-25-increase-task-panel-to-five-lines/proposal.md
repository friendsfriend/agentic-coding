## Why

The dashboard currently exposes only one task at a time, making it difficult to understand the surrounding work or see where the active task sits in the plan. A five-row task view with an explicit current-task position will make implementation progress and remaining work visible at a glance.

## What Changes

- Expand the dashboard task panel to display a five-row task viewport when tasks are available.
- Keep the currently active (first incomplete) task in the viewport's middle row whenever the task list has enough preceding and following tasks; pin the viewport to the beginning or end for tasks near either boundary.
- Render the beginning and ending portions of shorter task lists without empty task rows.
- Show each visible task's completion state and text while highlighting the active task.
- Show the active task position and total task count in the panel heading, including a sensible completed-state display when no task remains.
- Preserve the existing task-list detail modal and task navigation behavior.

## Capabilities

### New Capabilities

- `dashboard-task-progress`: Display a five-row, active-task-centered task viewport with current-task position and total-count information.

### Modified Capabilities

- None.

## Impact

- Dashboard task-panel rendering and task-window selection in `agentic-coding/src/tui/dash/App.tsx`.
- Dashboard task data derivation and demo/test fixtures in `agentic-coding/src/tui/dash/data.ts` and dashboard tests as needed.
- No API, workflow-state, persistence, or external dependency changes are expected.
