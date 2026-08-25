## MODIFIED Requirements

### Requirement: Finish the review from the popup
When the user finishes the developer review from the files popup, the dashboard SHALL immediately show a finishing-review progress indicator, save comments and dispatch the developer-review outcome, then clear the indicator and close the popup when the operation settles.

#### Scenario: Finish the review from the popup
- **WHEN** the user presses `f` in the files popup
- **THEN** the dashboard immediately shows a finishing-review progress indicator, saves comments and dispatches the developer-review outcome, then clears the indicator and closes the popup when the operation settles
