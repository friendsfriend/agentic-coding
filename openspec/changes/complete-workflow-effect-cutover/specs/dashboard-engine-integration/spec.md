## ADDED Requirements

### Requirement: Dashboard owns a cancellation-safe Effect application bridge
Workflow-facing dashboard operations SHALL use one narrow bridge to the shared Effect application runtime while components and pure projections remain native Solid/OpenTUI. Repository/workflow changes and unmount SHALL cancel obsolete owned work and reject late results. UI-provided credential interaction SHALL not introduce backend imports of TUI presentation.

#### Scenario: Selection changes during refresh
- **WHEN** an observation for one workflow completes after selection changes to another workflow
- **THEN** its result SHALL not overwrite the current selection's state
- **AND** its obsolete owned work SHALL be cancelled where supported

#### Scenario: Dashboard unmounts with a credential request
- **WHEN** dashboard disposal removes the interaction owner of an active credential request
- **THEN** the request SHALL be cancelled/resolved without retaining a secret or leaving its owned command waiting indefinitely

### Requirement: Effect UI cancellation preserves command authority
Dashboard SHALL continue to dispatch only engine-provided action IDs with the displayed revision through the in-process application boundary. Cancellation after possible commit SHALL trigger authoritative reconciliation rather than assumed rollback or automatic replay. Loading/error presentation SHALL not become workflow lifecycle authority.

#### Scenario: Action commits during navigation
- **WHEN** a valid action commits while the user navigates away before receiving its result
- **THEN** later observation SHALL show the committed revision
- **AND** the UI SHALL not replay the action or report that navigation rolled it back

#### Scenario: Stale action fails through Effect
- **WHEN** the submitted developer revision is stale
- **THEN** the UI SHALL render the typed rejection and refresh the authoritative view without introducing phase-derived action alternatives
