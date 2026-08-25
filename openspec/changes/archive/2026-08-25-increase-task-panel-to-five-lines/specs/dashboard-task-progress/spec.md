# dashboard-task-progress Specification

## Purpose

Defines the dashboard task panel's five-row progress view and its indication of the currently active task within the full task list.

## Requirements

## ADDED Requirements

### Requirement: Dashboard displays a bounded five-row task viewport

The dashboard task panel SHALL render each visible task as one content row, showing its completion state and text, and SHALL display no more than five task rows at once. When fewer than five tasks exist, the panel SHALL render all available tasks without blank task rows. When no tasks exist, the panel SHALL render a clear empty-state message.

#### Scenario: Five or more tasks are available

- **WHEN** the dashboard task panel renders a task list containing at least five tasks
- **THEN** it SHALL display exactly five consecutive task rows
- **AND** each row SHALL show the corresponding task's completion state and text

#### Scenario: Fewer than five tasks are available

- **WHEN** the dashboard task panel renders a non-empty task list containing fewer than five tasks
- **THEN** it SHALL display every task exactly once
- **AND** it SHALL NOT add empty task rows to reach five

#### Scenario: No tasks are available

- **WHEN** the dashboard task panel renders an empty task list
- **THEN** it SHALL display an explicit empty-state message instead of a task row

### Requirement: Active task remains centered within the viewport when possible

The dashboard SHALL define the active task as the first task in list order whose completion state is incomplete. For a list with more than five tasks, the task viewport SHALL be a consecutive five-task slice that places the active task in the third row whenever at least two tasks precede and at least two tasks follow it. The viewport SHALL be clamped at the beginning or end of the list when the active task is closer to a boundary.

#### Scenario: Active task can be centered

- **WHEN** the active task has at least two preceding tasks and at least two following tasks
- **THEN** the active task SHALL render in the third visible row
- **AND** the two preceding and two following tasks SHALL occupy the other visible rows in list order

#### Scenario: Active task is near the beginning

- **WHEN** the active task has fewer than two preceding tasks
- **THEN** the viewport SHALL begin with the first task
- **AND** the active task SHALL appear in the first or second visible row according to its list position

#### Scenario: Active task is near the end

- **WHEN** the active task has fewer than two following tasks
- **THEN** the viewport SHALL end with the last task
- **AND** the active task SHALL appear in the fourth or fifth visible row according to the number of following tasks

#### Scenario: All tasks are complete

- **WHEN** every task is complete
- **THEN** the dashboard SHALL show the ending portion of the task list, up to five rows
- **AND** it SHALL show no row as the active incomplete task

### Requirement: Task panel exposes active position and total count

The dashboard task panel heading SHALL communicate the active task's one-based position and the total number of tasks, such as “task 5 of 10”, whenever an active task exists. When all tasks are complete, the heading SHALL communicate completion together with the total task count. The active task row SHALL also be visually distinguishable from other incomplete rows.

#### Scenario: Active task position is shown

- **WHEN** the task list contains an active task at zero-based index four and ten total tasks
- **THEN** the task panel heading SHALL identify it as task 5 of 10
- **AND** the fifth task's row SHALL be visually distinguished as active

#### Scenario: Completion count is shown after the final task

- **WHEN** all ten tasks are complete
- **THEN** the task panel heading SHALL indicate that all ten tasks are complete
- **AND** no task row SHALL be styled as the active task

#### Scenario: Completion markers remain accurate

- **WHEN** visible tasks contain both complete and incomplete items
- **THEN** each row's completion marker SHALL reflect that task's own completion state
- **AND** the active-row styling SHALL not alter the completion state marker

### Requirement: Full task details remain available

The dashboard SHALL preserve the existing task-panel interaction that opens a detail view containing the complete ordered task list, including tasks outside the five-row viewport.

#### Scenario: User opens task details

- **WHEN** the task panel is focused and the user activates it
- **THEN** the dashboard SHALL open the task detail view
- **AND** the detail view SHALL contain every task in list order with its completion marker
