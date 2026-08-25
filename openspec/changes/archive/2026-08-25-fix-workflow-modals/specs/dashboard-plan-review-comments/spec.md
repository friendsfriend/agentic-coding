## ADDED Requirements

### Requirement: Direct popup open regardless of phase naming
The plan review user action SHALL open the artifact-list review popup directly whenever the workflow reaches the plan approval gate, regardless of whether the dashboard reports the phase as a legacy phase name (`proposed`) or an engine step id (`core.plan-approval`). The generic action-notice modal (a title/prompt-only list with no selectable items) SHALL NOT be shown for this gate.

#### Scenario: Engine step id opens the review popup directly
- **WHEN** the workflow reaches the plan approval gate and the dashboard reports the phase as `core.plan-approval`
- **THEN** the artifact-list review popup opens directly, without showing the generic "Action required" notice modal

#### Scenario: Legacy phase name keeps opening the review popup directly
- **WHEN** the workflow reaches the plan approval gate and the dashboard reports the phase as `proposed`
- **THEN** the artifact-list review popup opens directly, as before

#### Scenario: Required user action key is stable across phase naming
- **WHEN** the required plan review user action is computed for either `proposed` or `core.plan-approval`
- **THEN** both produce the same stable action key so the direct-open trigger matches in both cases
