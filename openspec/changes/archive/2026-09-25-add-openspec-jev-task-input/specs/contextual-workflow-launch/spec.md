## ADDED Requirements

### Requirement: Task-driven workflow types expose the task input
The contextual creation form SHALL render and submit a task input for every
registry workflow type whose planner is steered by a user task, including
`openspec-jev`. The form SHALL NOT silently omit the task step for a
task-driven type. Workflow types that select an existing OpenSpec change
instead of accepting a task SHALL keep their current task-free field set, and
the checkout behavior of each type SHALL NOT change.

#### Scenario: JEV workflow offers and submits a task
- **WHEN** the user selects the `openspec-jev` workflow type in the new-workflow form
- **THEN** the wizard SHALL present a task input step before the checkout mode step
- **AND** the submitted launch input SHALL carry the entered task text with workflow type `openspec-jev`

#### Scenario: Existing-change workflows stay task-free
- **WHEN** the user selects `openspec-apply` in the new-workflow form
- **THEN** the wizard SHALL continue to omit the task step and submit the launch input without a task
