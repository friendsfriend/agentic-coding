# dashboard-engine-integration Specification

## Purpose
TBD - created by archiving change dashboard-in-process-engine. Update Purpose after archive.
## Requirements
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

### Requirement: Event-driven refresh
Dashboard SHALL refresh from canonical workflow events, outbox status, runtime observations, and telemetry updates rather than fixed phase assumptions.

#### Scenario: Refresh reacts to workflow output
- **WHEN** state revision or effect status changes
- **THEN** dashboard SHALL refresh validated workflow view
- **AND** it SHALL render current step/run state and available actions from view

#### Scenario: Runtime observation changes
- **WHEN** Herdr agent status or telemetry changes without state revision
- **THEN** dashboard MAY refresh observation panels
- **AND** observation SHALL not be presented as committed step completion

### Requirement: Engine-provided workflow view
Dashboard SHALL consume one typed workflow view containing revision, pinned definition, current step, active runs, resolved runtime/profile per run, validation/attention state, and available actions. The view's available actions SHALL be the dashboard's only source of action availability; the dashboard SHALL NOT derive, extend, or filter that set from step or workflow definition identifiers. The dashboard SHALL remain the owner of user-facing presentation for those actions.

#### Scenario: Workflow uses additional registered step
- **WHEN** dashboard loads definition containing step not hardcoded in UI
- **THEN** it SHALL render registry-provided label/status/action metadata
- **AND** no UI phase list change SHALL be required for basic operation

#### Scenario: Repair UI opens
- **WHEN** developer requests repair
- **THEN** dashboard SHALL request compatible targets from engine
- **AND** repair modal SHALL show revision, target, and affected runs before dispatch, without a reason requirement
- **AND** a single Enter SHALL dispatch repair with current revision regardless of whether a reason was provided

#### Scenario: Dashboard offers exactly the engine's actions
- **WHEN** the dashboard presents the required developer action for a workflow whose view carries available actions
- **THEN** the offered items SHALL correspond exactly to the actions the engine reported as available
- **AND** the dashboard SHALL NOT offer an action the engine did not report
- **AND** the dashboard SHALL NOT withhold an action the engine did report

#### Scenario: Presentation stays in the dashboard
- **WHEN** an action is rendered
- **THEN** its title, prompt, and item label SHALL come from dashboard-owned copy keyed by the action identifier
- **AND** the engine SHALL NOT be required to supply user-facing presentation strings

### Requirement: Dashboard actions are dispatchable
Every action the dashboard offers SHALL be an action the engine can dispatch for the workflow's current revision and step. The dashboard SHALL NOT present an action identifier the engine does not define.

#### Scenario: Terminal action set matches the engine
- **WHEN** a completed workflow whose lifecycle produces no reviewable code change is presented
- **THEN** the dashboard SHALL NOT offer a pull-request action
- **AND** this SHALL hold for every definition the engine treats as close-only, with no separate dashboard allowlist

#### Scenario: Undefined action is not offered
- **WHEN** the dashboard builds the item list for a required developer action
- **THEN** every item that dispatches to the engine SHALL carry an action identifier present in the view's available actions
- **AND** an item whose identifier has no engine action SHALL NOT be rendered

#### Scenario: Legacy view without actions
- **WHEN** a workflow view carries no available-actions array
- **THEN** the dashboard SHALL fall back to its legacy phase-derived action set
- **AND** the fallback SHALL be limited to views that carry no actions array

### Requirement: Observational workflow reads
CLI status, workflow list/snapshot/view reads, dashboard refresh, and dashboard JSON rendering SHALL not create or migrate workflow stores, import legacy rows, expire questions/runs, claim effects, or initiate external workflow work. Missing or incompatible stores SHALL produce read-only absent or migration-required diagnostics.

#### Scenario: Pending effect is observed
- **WHEN** a caller repeatedly reads a workflow with pending or retryable effects
- **THEN** effect attempts, leases, workflow revision, and run ownership SHALL remain unchanged by those reads
- **AND** no Git mutation, workspace creation, or agent launch SHALL be initiated by reading

#### Scenario: Expired question is observed
- **WHEN** a read occurs after a pending question's deadline
- **THEN** the view SHALL represent its elapsed deadline without requiring a persisted expiry mutation
- **AND** the read SHALL not append an event or increment revision

#### Scenario: Old or missing store is observed
- **WHEN** home listing or status encounters an absent or unsupported legacy schema
- **THEN** it SHALL return an appropriate diagnostic without creating files or modifying schema/source records

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

