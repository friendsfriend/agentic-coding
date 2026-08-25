## MODIFIED Requirements

### Requirement: Finish checks comments and dispatches the matching action
Finishing the plan review SHALL immediately show a finishing-review progress indicator while it checks comments, persists them when applicable, and dispatches the matching action. Without comments the workflow SHALL dispatch the plan approval action so the worker starts implementation; with comments the workflow SHALL save the comments and dispatch the review-comments action with a bounded payload so the planner receives the feedback. The indicator SHALL clear and the review SHALL close when the operation settles.

#### Scenario: Finish without comments approves the plan
- **WHEN** the user presses `f` in the plan review and no comments exist
- **THEN** the review shows the finishing-review progress indicator, dispatches the plan approval action, then closes and clears the indicator

#### Scenario: Finish with comments sends feedback to the planner
- **WHEN** the user presses `f` in the plan review and comments exist
- **THEN** the review shows the finishing-review progress indicator, closes after the comments are persisted and the review-comments action is dispatched, and clears the indicator

#### Scenario: Comments persist for the review round
- **WHEN** the plan review is finished with comments
- **THEN** the comments are written to `reviews/plan-review.json` under the workflow's change directory while the finishing-review progress indicator remains visible
