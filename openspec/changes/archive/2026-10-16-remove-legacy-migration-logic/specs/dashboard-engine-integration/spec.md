## MODIFIED Requirements

### Requirement: Dashboard actions are dispatchable
Every action the dashboard offers SHALL be an action the engine can dispatch for the workflow's current revision and step. The dashboard SHALL NOT present an action identifier the engine does not define, and SHALL NOT infer actions from an old view shape.

#### Scenario: Terminal action set matches the engine
- **WHEN** a completed workflow whose lifecycle produces no reviewable code change is presented
- **THEN** the dashboard SHALL NOT offer a pull-request action
- **AND** this SHALL hold for every definition the engine treats as close-only, with no separate dashboard allowlist

#### Scenario: Undefined action is not offered
- **WHEN** the dashboard builds the item list for a required developer action
- **THEN** every item that dispatches to the engine SHALL carry an action identifier present in the view's available actions
- **AND** an item whose identifier has no engine action SHALL NOT be rendered

### Requirement: Observational workflow reads
CLI status, workflow list/snapshot/view reads, dashboard refresh, and dashboard JSON rendering SHALL not create current workflow stores, import rows, upgrade schemas, expire questions/runs, claim effects, or initiate external workflow work. Missing stores SHALL remain absent; existing non-v6 stores SHALL surface the current store's unsupported-version diagnostic without modification.

#### Scenario: Pending effect is observed
- **WHEN** a caller repeatedly reads a workflow with pending or retryable effects
- **THEN** effect attempts, leases, workflow revision, and run ownership SHALL remain unchanged by those reads
- **AND** no Git mutation, workspace creation, or agent launch SHALL be initiated by reading

#### Scenario: Expired question is observed
- **WHEN** a read occurs after a pending question's deadline
- **THEN** the view SHALL represent its elapsed deadline without requiring a persisted expiry mutation
- **AND** the read SHALL not append an event or increment revision

#### Scenario: Unsupported or missing store is observed
- **WHEN** home listing or status encounters an absent store or an existing non-v6 schema
- **THEN** it SHALL leave storage unchanged and identify the absent state or exact unsupported version
