## MODIFIED Requirements

### Requirement: One feature-preserving terminal shell
The full application SHALL render environment, workflow, observability and Wiki capabilities under one OpenTUI renderer with shared page-based chrome rather than navigation tab bars. Existing operational capabilities SHALL remain reachable, including environment categories, providers/issues/change requests/CI, agent utilities, workflow reviews/questions/configuration and telemetry detail views. The existing workflow entry SHALL remain a temporary page until contextual launch and centralized Settings replace it.

#### Scenario: User moves between domains
- **WHEN** a user opens telemetry from an environment and later returns
- **THEN** navigation SHALL occur inside the same renderer without starting another TUI root
- **AND** returning SHALL restore the relevant route identity, selection and draft state

### Requirement: Preserve feature-specific panel navigation
Shared panel framing SHALL preserve workflow directional grid movement, rendered-panel filtering and in-panel scroll semantics. Tab/Shift+Tab SHALL traverse page-local focus regions rather than switch shell destinations.

#### Scenario: OpenSpec panel is absent
- **WHEN** no artifacts render and the user moves workflow panel focus
- **THEN** navigation SHALL skip the absent panel and retain the existing grid wrap behavior

### Requirement: Services outlive feature visibility
Workflow execution coordinators, telemetry listeners/watchers and database lifetimes SHALL be owned by the application root independently of feature visibility. Feature rendering SHALL NOT create additional execution coordinators or claim durable effects.

#### Scenario: Change page during workflow execution
- **WHEN** the user leaves a workflow view while an execution pass is active
- **THEN** execution and lease renewal SHALL continue under the same root owner
- **AND** showing that view again SHALL subscribe to authoritative state without duplicating execution

#### Scenario: External tool temporarily owns terminal
- **WHEN** the renderer is suspended while a foreground terminal utility runs
- **THEN** asynchronous child waiting SHALL allow workflow lease renewal and telemetry processing to continue
- **AND** renderer/input ownership SHALL be restored on success, failure or cancellation

#### Scenario: Dispose application
- **WHEN** the application owner is disposed
- **THEN** owned services SHALL be cancelled/finalized once without disposing another application's resources
