## MODIFIED Requirements

### Requirement: In-process engine use
The dashboard SHALL invoke the unified workflow application through its typed authenticated backend client and submit only action identifiers returned in the latest workflow view. The server SHALL invoke the engine in-process; the dashboard SHALL NOT own engine execution or dispatch workflow subprocesses.

#### Scenario: Workflow action runs in-process
- **WHEN** the dashboard triggers available approval, review, resume, delivery, PR, close or another action
- **THEN** the client SHALL submit the displayed action ID and revision and the server SHALL call the engine dispatcher in-process
- **AND** neither boundary SHALL map phase names to command handlers or spawn a workflow command to dispatch it

#### Scenario: Action confirmation dispatches on first valid Enter
- **WHEN** a developer selects an available action with confirm or reason confirmation mode
- **THEN** the dashboard SHALL dispatch on the first Enter once any required reason is non-empty
- **AND** it SHALL NOT require a second separate confirming Enter

#### Scenario: Dashboard action is stale
- **WHEN** workflow revision changes after view render
- **THEN** the action SHALL fail without mutation
- **AND** the dashboard SHALL refresh current view and available actions

#### Scenario: Agent shim unaffected
- **WHEN** a managed agent submits generic handoff
- **THEN** it SHALL invoke `agentic-coding workflow handoff` directly with existing identity checks
- **AND** the client/server boundary SHALL NOT require or preserve a legacy phase shim

### Requirement: Single shared Herdr client
There SHALL be one backend Herdr client module that parses the `.result` envelope and provides pane-geometry helpers for engine and dashboard-requested operations. Dashboard presentation SHALL request these operations through the typed API rather than invoking Herdr locally.

#### Scenario: One envelope parser
- **WHEN** a developer inspects Herdr access across the codebase
- **THEN** the `.result` envelope SHALL be parsed in exactly one module
- **AND** pane-geometry/direction math SHALL be defined once and reused by backend launch and focus operations

### Requirement: Dashboard execution has explicit lifecycle ownership
The server SHALL own at most one execution coordinator per open repository, separate from client view refresh. Explicit dashboard commands SHALL carry displayed action ID and revision through the typed client to server-side engine dispatch. Runner failures SHALL remain visible.

#### Scenario: Refresh bursts while work executes
- **WHEN** many events or refresh requests occur during an active execution pass
- **THEN** refresh SHALL NOT create additional coordinators or claim effects
- **AND** observation updates SHALL remain independent of workflow execution authority

#### Scenario: Action requests continuation
- **WHEN** an accepted dashboard action commits requested effects
- **THEN** the existing server repository coordinator SHALL be notified explicitly
- **AND** the dashboard SHALL NOT spawn a workflow command subprocess

#### Scenario: Coordinator fails or dashboard closes
- **WHEN** a coordinator fails or a dashboard client closes
- **THEN** failure/pending-work state SHALL remain actionable and client-owned work SHALL be cleaned up without disposing a separately owned server
- **AND** owned server shutdown SHALL finalize coordinators safely so a later explicit execution pass recovers under lease rules

### Requirement: Dashboard owns a cancellation-safe Effect application bridge
Workflow-facing dashboard operations SHALL use one narrow typed client to the server-owned Effect application runtime while components/projections remain native Solid/OpenTUI. Repository/workflow changes and unmount SHALL cancel obsolete client work and reject late results. Credential interactions SHALL NOT introduce backend imports of TUI presentation.

#### Scenario: Selection changes during refresh
- **WHEN** an observation completes after selection changes to another workflow
- **THEN** its result SHALL NOT overwrite current selection state
- **AND** obsolete owned request work SHALL be cancelled where supported

#### Scenario: Dashboard unmounts with a credential request
- **WHEN** disposal removes the controlling interaction owner of an active credential request
- **THEN** that request SHALL be cancelled/resolved within its bound without retaining a secret or waiting indefinitely

### Requirement: Effect UI cancellation preserves command authority
Dashboard SHALL dispatch only engine-provided action IDs and displayed revisions through the typed API to the server application boundary. Cancellation after possible commit SHALL trigger authoritative reconciliation rather than assumed rollback or automatic replay. Loading/error presentation SHALL NOT become workflow lifecycle authority.

#### Scenario: Action commits during navigation
- **WHEN** a valid action commits while the user navigates away before receiving its result
- **THEN** later observation SHALL show the committed revision
- **AND** the UI SHALL NOT replay the action or report navigation rolled it back

#### Scenario: Stale action fails through Effect
- **WHEN** the submitted developer revision is stale
- **THEN** the UI SHALL render typed rejection and refresh authoritative view without phase-derived action alternatives
