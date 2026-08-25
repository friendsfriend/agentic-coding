## ADDED Requirements

### Requirement: Direct popup open regardless of phase naming
The developer review user action SHALL open the changed-files review popup directly whenever the workflow reaches the developer review step, regardless of whether the dashboard reports the phase as a legacy phase name (`developer-review`) or an engine step id (`core.developer-review`). The generic action-notice modal (a title/prompt-only list with no selectable items) SHALL NOT be shown for this step.

#### Scenario: Engine step id opens the review popup directly
- **WHEN** the workflow reaches the developer review step and the dashboard reports the phase as `core.developer-review`
- **THEN** the changed-files review popup opens directly, without showing the generic "Action required" notice modal

#### Scenario: Legacy phase name keeps opening the review popup directly
- **WHEN** the workflow reaches the developer review step and the dashboard reports the phase as `developer-review`
- **THEN** the changed-files review popup opens directly, as before

#### Scenario: Required user action key is stable across phase naming
- **WHEN** the required developer review user action is computed for either `developer-review` or `core.developer-review`
- **THEN** both produce the same stable action key so the direct-open trigger matches in both cases
