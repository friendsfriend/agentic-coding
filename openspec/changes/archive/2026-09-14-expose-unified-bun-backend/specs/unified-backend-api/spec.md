## ADDED Requirements

### Requirement: Bun server owns workflow and telemetry execution
The Bun server SHALL own workflow application scopes, repository execution coordinators, observations, telemetry ingestion/watchers/retention and database lifetimes. TUI views SHALL consume typed API data/actions without direct backend I/O. Go environment routes SHALL remain private delegated capabilities until ported.

#### Scenario: Renderer is suspended for external tool
- **WHEN** a terminal utility blocks or suspends the TUI
- **THEN** backend execution, lease renewal and telemetry ingestion SHALL continue independently

#### Scenario: Feature view unmounts
- **WHEN** a feature view unmounts
- **THEN** obsolete client requests SHALL be cancelled and late results rejected
- **AND** backend services SHALL retain application-level ownership

### Requirement: Authenticated bounded API
Public and private API boundaries SHALL validate method, schema, identity, permissions and payload/path bounds. Loopback binding SHALL be the default but SHALL NOT substitute for authorization. Developer sessions and agent run capabilities SHALL have distinct authority; credentials SHALL NOT be carried in URLs or logs.

#### Scenario: Forged or stale agent command
- **WHEN** a command supplies invalid capability, wrong run identity or stale revision
- **THEN** the backend SHALL reject it without mutation using bounded structured diagnostics

#### Scenario: Untrusted local browser request
- **WHEN** a request lacks required authorization or violates origin/method policy
- **THEN** the API SHALL reject it and SHALL NOT delegate an environment mutation to Go

### Requirement: Reads remain observational across transport
Status/list/view/artifact observations SHALL retain existing no-mutation guarantees. Transport errors after potential mutation SHALL require authoritative reconciliation rather than unclassified automatic replay.

#### Scenario: Repeated read of pending effects
- **WHEN** clients repeatedly inspect a workflow with pending effects or an old store
- **THEN** reads SHALL NOT initialize/migrate the store, expire questions, claim effects or increment revisions

#### Scenario: Mutation response is lost
- **WHEN** a valid command may have committed before connection loss
- **THEN** the client SHALL reconcile authoritative state or command identity
- **AND** it SHALL NOT assume rollback or blindly replay the mutation

### Requirement: Scoped interactive credential transport
Credential requests SHALL be ephemeral interactions bound to an operation and controlling authenticated client. Responses SHALL be single-owner, bounded and cancelled/expired on loss of that interaction owner; secret values SHALL NOT enter durable records or general event broadcasts.

#### Scenario: Credential client disconnects
- **WHEN** the controlling client disconnects during a credential request
- **THEN** the request SHALL cancel or expire within its bound and unblock owned work safely
- **AND** no secret or stale response channel SHALL remain persisted

#### Scenario: Another client attempts response
- **WHEN** a different client submits an answer to the credential interaction
- **THEN** the backend SHALL reject it without using the supplied value

### Requirement: Recoverable bounded event streams
Event envelopes SHALL identify server instance, domain, resource/run and ordering/revision context. Clients SHALL recover gaps by bounded replay or authoritative snapshots/history. Slow clients SHALL NOT block execution; durable command output SHALL be recoverable after emission loss.

#### Scenario: Reconnect cursor is too old
- **WHEN** a client reconnects outside the replay window
- **THEN** the server SHALL require snapshot/history resynchronization rather than silently continue from a gap

#### Scenario: Client stops reading output
- **WHEN** a client cannot consume a burst of command output
- **THEN** backend mutation/execution SHALL remain nonblocking
- **AND** the client SHALL be able to recover persisted output with stable cursor/range semantics

### Requirement: CLI and attach share authoritative backend contracts
Supported CLI operations SHALL retain their existing command semantics and process-ancestry/run-capability checks while invoking the authenticated application boundary. Full-feature attach SHALL identify server capabilities and render server-owned data rather than mixing in implicit client-local repositories.

#### Scenario: Managed agent invokes handoff
- **WHEN** an authenticated managed agent invokes the supported workflow handoff command
- **THEN** CLI caller identity and backend capability checks SHALL both apply
- **AND** the same generic handoff semantics SHALL hold without phase-specific translation
