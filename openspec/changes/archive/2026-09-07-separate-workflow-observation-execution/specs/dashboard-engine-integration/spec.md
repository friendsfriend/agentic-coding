## ADDED Requirements

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
The dashboard SHALL own at most one execution coordinator per open repository, separate from view refresh. Explicit command submission SHALL retain in-process engine dispatch with the displayed action ID and revision. Runner failures SHALL be visible rather than silently swallowed.

#### Scenario: Refresh bursts while work executes
- **WHEN** many file events or refresh requests occur during an active execution pass
- **THEN** refresh SHALL not create additional drain coordinators or claim effects
- **AND** observation updates SHALL remain independent of workflow execution authority

#### Scenario: Action requests continuation
- **WHEN** an accepted dashboard action commits requested effects
- **THEN** the existing repository coordinator SHALL be notified explicitly to continue execution
- **AND** the dashboard SHALL not spawn a workflow command subprocess to dispatch that action

#### Scenario: Coordinator fails or dashboard closes
- **WHEN** an execution coordinator fails or its dashboard owner is disposed
- **THEN** failure or pending-work state SHALL remain visible in an actionable form and owned timers/subprocesses SHALL be cleaned up or explicitly handed to continuation
- **AND** a later explicit execution pass SHALL recover durable work under lease rules
