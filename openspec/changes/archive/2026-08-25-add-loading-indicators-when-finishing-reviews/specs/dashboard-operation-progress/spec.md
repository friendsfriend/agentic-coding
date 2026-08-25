## ADDED Requirements

### Requirement: Workflow creation shows progress immediately
When the user confirms a new workflow, the dashboard SHALL display a workflow-creation progress indicator before the completion operation begins blocking or performing its work, and SHALL keep the indicator visible until that operation settles.

#### Scenario: Creation indicator appears after confirmation
- **WHEN** the user presses Enter on the new-workflow confirmation step
- **THEN** the "Creating workflow" progress indicator is rendered before the workflow completion callback begins its work

#### Scenario: Creation indicator clears after completion
- **WHEN** new-workflow completion resolves or fails
- **THEN** the creation progress indicator is removed and the existing completion or error behavior is preserved

### Requirement: Review finishing shows operation progress
When the user finishes a valid plan or developer review, the dashboard SHALL show an operation-specific progress indicator while review comments are persisted and the corresponding workflow action is dispatched, including when the operation completes through the demo/test path.

#### Scenario: Developer review enters finishing progress
- **WHEN** the user presses `f` in the developer review popup during the developer-review phase
- **THEN** a finishing-review progress indicator is visible while the developer review operation is in flight

#### Scenario: Plan review enters finishing progress
- **WHEN** the user presses `f` in the plan review popup
- **THEN** a finishing-review progress indicator is visible while the plan review operation is in flight

#### Scenario: Review progress clears after the operation settles
- **WHEN** the developer-review or plan-review save/dispatch operation resolves or fails
- **THEN** the finishing-review progress indicator is removed and the existing review close, workflow outcome, or error behavior is preserved

#### Scenario: Existing status feedback remains available
- **WHEN** a review-finish progress indicator is visible
- **THEN** the existing operation status message remains available alongside the indicator
