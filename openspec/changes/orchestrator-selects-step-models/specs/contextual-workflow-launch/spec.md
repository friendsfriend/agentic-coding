## MODIFIED Requirements

### Requirement: Task-driven workflow types expose the task input
The contextual creation form SHALL render and submit a task input for every
registry workflow type whose planner is steered by a user task, including
`openspec` and the fusion workflow types. The form SHALL NOT silently omit the
task step for a task-driven type. Workflow types that select an existing
OpenSpec change instead of accepting a task SHALL keep their current task-free
field set, and the checkout behavior of each type SHALL NOT change.

#### Scenario: JEV workflow offers and submits a task
- **WHEN** the user selects the `openspec` workflow type in the new-workflow form
- **THEN** the wizard SHALL present a task input step before the checkout mode step
- **AND** the submitted launch input SHALL carry the entered task text with workflow type `openspec`

#### Scenario: Existing-change workflows stay task-free
- **WHEN** the user selects `openspec-apply` in the new-workflow form
- **THEN** the wizard SHALL continue to omit the task step and submit the launch input without a task

### Requirement: Classifier-routed workflow catalog exposure

The contextual creation form and the CLI workflow catalog SHALL expose the
registered OpenSpec family: `openspec`, `openspec-apply`, `openspec-propose`,
`openspec-fusion`, and `openspec-fusion-propose`, alongside the unchanged
`no-openspec`, `wiki`, and `research` types. Removed identifiers SHALL NOT be
offered. Starting one of these types SHALL NOT require a selected agent preset:
the form's preset selection SHALL remain optional and a launch without one SHALL
resolve every step through the configured routes, definition defaults, and the
built-in model-agnostic profile.

#### Scenario: Form lists the current OpenSpec family
- **WHEN** the user opens the new-workflow form
- **THEN** the offered OpenSpec workflow types SHALL be `openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`, and `openspec-fusion-propose`
- **AND** removed identifiers SHALL NOT be selectable

#### Scenario: Apply uses the discovered change picker
- **WHEN** the user selects `openspec-apply` for a repository containing OpenSpec changes
- **THEN** the workflow-id step SHALL render the repository's discovered change ids as a selectable list
- **AND** submitting the form SHALL use the selected change id as the workflow id

#### Scenario: Submitting without a preset is accepted
- **WHEN** the user submits the form with `Config defaults` as the agent preset
- **THEN** the launch SHALL be accepted
- **AND** the started workflow SHALL resolve its step models through the configured fallback chain

#### Scenario: Removed type is not offered
- **WHEN** the form is rendered after the removed definitions are unregistered
- **THEN** `openspec-full`, `openspec-jev`, and `openspec-jev-apply` SHALL NOT appear as selectable workflow types
