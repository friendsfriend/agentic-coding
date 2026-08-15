## ADDED Requirements

### Requirement: Plan approval review comments route to the planner
The plan approval gate SHALL accept a bounded `review-comments` developer action whose `comments` outcome returns the workflow to the planning step with the comments carried as planner step input, so the planner can adjust the plan against the feedback. The feedback loop SHALL be capped by the same retry bound as plan rejection.

#### Scenario: Comments outcome returns to planning with feedback
- **WHEN** the developer dispatches `review-comments` at the plan approval gate with a bounded comments payload
- **THEN** the workflow transitions to the planning step with the comments payload available as planner step input

#### Scenario: Bounded comment validation
- **WHEN** the developer dispatches `review-comments` with an empty, oversized, or malformed comments payload
- **THEN** the engine SHALL reject the action without mutating workflow state

#### Scenario: Approval still starts implementation
- **WHEN** the developer dispatches the plan approval action at the plan approval gate
- **THEN** the workflow transitions to the implementation step as before

#### Scenario: Feedback loop is capped
- **WHEN** the comments outcome repeats beyond the plan gate retry bound
- **THEN** the engine SHALL stop the loop and require operator attention
