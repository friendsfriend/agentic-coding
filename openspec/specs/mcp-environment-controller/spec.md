# mcp-environment-controller Specification

## Purpose

Provide portable MCP environment management through a shared authenticated controller, preserving controller-owned execution scopes, exact-plan human approval, original live-resource ownership, conservative recovery and bounded diagnostics independently of client presentation or model execution.

## Requirements

### Requirement: Read-only MCP catalog milestone

The system SHALL provide a dedicated stdio MCP entrypoint exposing `env_list` and `env_discover` without opening the native agent host, resolving provider credentials, reading `.env`, launching runtime clients, writing definitions, reserving resources or adopting native state. Unsupported mutation and approval tools MUST NOT be advertised.

#### Scenario: Catalog inspection without an agent runtime
- **WHEN** an MCP client lists tools and requests configured environments with an explicit operator-selected configuration directory and repository allowlist
- **THEN** it receives bounded public catalog metadata with inspection-only semantics and no execution authority
- **AND** no agent model, native task host or runtime process is started

### Requirement: Explicit repository authorization and bounded output

The catalog adapter SHALL reuse existing v2 validation and discovery behavior and restrict reads to explicitly authorized canonical repository roots. Catalog results SHALL be paged and omit executable commands, literal environment values and secret-reference mappings. Errors SHALL be sanitized, and transport arguments SHALL reject unknown fields.

#### Scenario: Discover authorized project hints
- **WHEN** a caller requests discovery for an authorized repository
- **THEN** the response contains bounded untrusted hints rather than executable targets, approval or readiness

#### Scenario: Refuse authority expansion
- **WHEN** a caller requests another repository or attempts to supply execution/owner arguments
- **THEN** the request fails without leaking underlying filesystem/configuration errors or executing anything

### Requirement: Controller-owned scope boundary before mutations

Before advertising mutating tools, the system SHALL durably bind operations to controller-issued execution scopes and authenticated principals, capture immutable plans, content-bind idempotency keys, and enforce original live-handle resource ownership. Disconnect SHALL NOT imply task completion. Saved process/container IDs SHALL NOT restore authority after restart.

#### Scenario: Cross-owner request
- **WHEN** one scope requests control over another scope's environment
- **THEN** the controller refuses without dispatching a runtime operation

#### Scenario: Ambiguous interruption
- **WHEN** the controller restarts after issuance without a settled result
- **THEN** the operation remains uncertain/quarantined rather than being automatically resent or adopted

### Requirement: Human-only exact-plan approval

Before enabling execution, the system SHALL expose an authenticated operator interface to inspect and decide the exact frozen plan with digest/revision fencing. MCP tool permission, model-generated intent and code-review approval SHALL NOT authorize environment execution. Human approval and quarantine/revocation controls SHALL NOT be model-callable tools.

#### Scenario: Pending approval
- **WHEN** an agent requests a configured environment action
- **THEN** no configured command or runtime mutation executes until the operator approves its exact current plan

### Requirement: Portable presentation-independent results

The MCP interface SHALL return readable text and structured data without requiring an OpenCode plugin or embedded UI. Future specialized UIs SHALL be adapters over controller state, not independent execution authorities.

#### Scenario: Generic MCP client
- **WHEN** a client without custom rendering inspects an environment
- **THEN** the supported result remains understandable and usable without JSX, HTML or proprietary UI events

### Requirement: Operator-only approval transport

The first operator HTTP adapter SHALL bind only numeric loopback, use a fresh bearer credential distinct from agent context, reject foreign Host/Origin and unknown decision fields, and bound decision bodies and in-flight work. It SHALL expose exact-plan inspection and digest/revision-fenced decisions without automatically executing an approval. It MUST NOT authenticate through cookies or query parameters.

#### Scenario: Approve the exact frozen plan
- **WHEN** an authenticated operator approves the current digest and revision
- **THEN** the decision is retained idempotently and no command starts until a separate authorized execution request

#### Scenario: Refuse forged or stale approval
- **WHEN** a caller supplies a missing/foreign credential, a foreign origin, a stale revision or extra principal fields
- **THEN** no approval or execution occurs and sensitive error details are withheld

### Requirement: Explicitly bound shell MCP execution

Execution tools SHALL be registered only when an embedding host supplies an authenticated fixed scope. Admission SHALL freeze configured shell plans and source HEAD without resolving secret values. Dispatch SHALL recheck owner/workspace/HEAD, journal issuance before effects and execute at most once through original live handles. Actual unsuccessful build/test exits MUST remain failed outcomes. Unsupported executable subsets SHALL fail closed. The default stdio inspection entrypoint SHALL remain read-only until shared authenticated serving is available.

#### Scenario: Owned execution and cancellation
- **WHEN** a scoped client separately executes an approved shell plan and later stops its running or starting environment
- **THEN** the controller records actual readiness/exit or cancellation results and cleans only its original live process groups
- **AND** another scope cannot inspect the operation or control those processes

#### Scenario: Historical requests grant no new effects
- **WHEN** an issued/completed operation or successful stop request is replayed, including after reopen
- **THEN** the returned record is historical and does not resend a command, restore process authority or cancel a newer generation

### Requirement: Shared authenticated transport and stdio bridge

The shared MCP listener SHALL authenticate numeric-loopback HTTP requests against operator-provisioned fixed principal/scope bindings and SHALL share one resource controller across clients. It MUST reject foreign Host/Origin, URL credential parameters and unauthenticated requests, and bound requests/subscriptions. The stdio execution mode SHALL bridge to that listener without opening controller state, creating scopes, retrying calls or closing resources on disconnect. Agent and operator credentials MUST NOT be interchangeable.

#### Scenario: Two clients share one resource authority
- **WHEN** separate credentials connect over HTTP and a stdio bridge
- **THEN** each client sees only its bound operation/run state and cannot select another owner through arguments or metadata
- **AND** disconnecting a bridge leaves held environments and other clients intact

### Requirement: Explicit and idle scope cleanup

The controller SHALL provide content-bound, revision-fenced scope close and SHALL fence new work before original-handle cleanup. Job/interactive scopes SHALL expire through that same cleanup path after their configured idle duration, except while execution/acquisition/startup is in flight. Direct client environment use SHALL renew only its own active scope; passive operator reads SHALL NOT renew it. Operator infrastructure SHALL require explicit closure and MUST NOT expire by agent idle policy. Failed/ambiguous cleanup SHALL remain inspection-required without restored authority on reopen.

#### Scenario: Close and expiry clean original live resources
- **WHEN** an active client explicitly closes its scope or the idle sweep establishes its expiry
- **THEN** pending unissued plans are fenced, original owned work is aborted/joined and confirmed cleanup marks the scope closed
- **AND** expired/closed scope receipts never rearm execution

#### Scenario: Work and protected infrastructure are not idle
- **WHEN** a scope has in-flight execution or is operator infrastructure
- **THEN** the idle sweep does not close it merely because the wall clock passed an agent duration

### Requirement: Private daemon bootstrap

The daemon CLI SHALL require explicit state/config/client/repository definitions and SHALL publish a fresh operator capability only through an exclusive mode-0600 file in private controller state. It MUST NOT print credentials, overwrite an existing access file or remove a replaced/edited file at shutdown. Normal shutdown SHALL join listener/resource cleanup and release only its original files/lock.

#### Scenario: Start and stop an explicitly configured daemon
- **WHEN** an operator starts the shared daemon with valid client definitions and later signals shutdown
- **THEN** MCP and operator access are independently authenticated, stdout contains no credentials, and shutdown completes with original resource cleanup joined and only the original private access file and state lock released

### Requirement: Reuse native runtime and dependency authority

The controller SHALL dispatch validated shell, Docker/Podman, Compose and explicit Kubernetes pod/Deployment/Helm plans through the existing manager and adapters without a second resource engine. It SHALL retain prepared cluster references, frozen chart inputs, original creation receipts, native lifetime validation and dependent-first cleanup. Model tools SHALL NOT grant protected operator lifetime/marker authority.

#### Scenario: Explicit runtime selection preserves native refusal
- **WHEN** a scoped client selects a configured runtime, replica count or agent lifetime
- **THEN** the frozen intent preserves that selection and native validators reject unsupported combinations before approval rather than guessing a fallback

### Requirement: Foreign prerequisites remain pinned and owner-bound

Foreign projects SHALL be admitted only through the configured prerequisite closure. Their plans SHALL belong to the same controller owner through the original dependency-workspace capability, with captured commit and directory/Git identity. Approval SHALL NOT authorize executing in the foreign developer checkout or copying uncommitted changes. Shared prerequisite generations SHALL remain held until their last live root releases them under the native lifetime rules.

#### Scenario: Foreign source changes after approval
- **WHEN** the foreign source HEAD or uncommitted files change after plan capture
- **THEN** execution uses the captured private detached worktree/commit and does not modify or adopt the developer checkout

#### Scenario: Last-reference release
- **WHEN** two owned roots reference one original prerequisite and one root stops
- **THEN** the prerequisite remains running for the other root and is cleaned only after its last reference is released

### Requirement: Receipts do not invent running or successful outcomes

The controller SHALL distinguish queue-wait receipts, actual running resources, settled exits and uncertain effects. Unsuccessful exits MUST NOT be reported as successful verification. Observation excerpts SHALL be bounded by encoded JSON size, preserve complete resource identities/URLs and report omitted evidence.

#### Scenario: Queue or exit observation
- **WHEN** dispatch returns a bounded acquisition receipt without runs, or the latest run observation has exited
- **THEN** the controller does not report a live running app merely because an execution request settled

### Requirement: Scope-bound observation tools

The MCP interface SHALL expose already-redacted native log and telemetry queries with the transport's fixed owner. Log source/time/byte windows and omission metadata SHALL remain native behavior. Telemetry SHALL require the original live ready run/receiver and current dependency generations. Callers MUST NOT select arbitrary owners, connections, backends or restored resource identities.

#### Scenario: Observe only owned evidence
- **WHEN** a scoped client requests app logs or opt-in telemetry
- **THEN** only that scope's retained logs or original live receiver observations are returned
- **AND** another scope cannot borrow the held app or receiver by naming its app/run

### Requirement: Exact-approved HTTP and SQL diagnostics

HTTP and SQL preparation SHALL normalize/validate native inputs and freeze the original prepared descriptor in the controller approval journal. Human decisions SHALL remain operator-only and exact digest/revision-fenced. Admission/approval SHALL NOT dispatch. Execution SHALL separately journal issuance and retain native ownership, credential-reference, TLS, root/generation, cancellation, rollback and no-resend fences. No caller-supplied credentials or database connections SHALL be accepted.

#### Scenario: One approved HTTP operation
- **WHEN** an operator approves a scoped HTTP snapshot and the client separately executes it
- **THEN** one native request is sent, redacted results are retained and repeated execution returns history without resending

#### Scenario: Generation changed after approval
- **WHEN** an approved diagnostic's held app is replaced or stopped before dispatch
- **THEN** the native generation guard refuses rather than re-preparing against the new app

### Requirement: Historical diagnostic data is not authority

Diagnostic receipts SHALL distinguish completed retained results from uncertain issuance. Historical reads SHALL authorize exact owner/run before native history projection, use bounded cursor pages without skipping undisplayed records and never resend a request/query. Presentation-budget loss SHALL be reported without misclassifying completed I/O as uncertain execution.

#### Scenario: Inspect a completed diagnostic
- **WHEN** a client reads an owned exact diagnostic ID, including after resources close
- **THEN** the retained redacted result or explicit omission is returned as history, not fresh execution or connection authority

### Requirement: Operator-only definitions and recovery

The separate authenticated operator interface SHALL expose native staging,
preflight, promotion and recovery controls without registering them as MCP tools.
It SHALL retain exact content/revision/request identity and destination fences,
durable publication receipts and uncertain-attempt barriers. Revocation SHALL
require original live authority and fence the whole owner; saved IDs MUST NOT
restore cleanup authority. Acknowledgement SHALL require an exact interrupted
revision and SHALL NOT claim to clean or adopt resources.

#### Scenario: Publish exact staged content
- **WHEN** an authenticated operator approves the exact staged digest and revision
- **THEN** native promotion publishes the approved bytes under its destination fence
- **AND** replay returns the original receipt without another publication

#### Scenario: Staging and recovery cannot borrow agent authority
- **WHEN** an agent credential is used on operator control routes
- **THEN** authentication fails before staging, publication or recovery changes

### Requirement: Stopped-host cutover documentation

The migration guide SHALL document implemented parity and remaining lifecycle/UI
gaps, require the old host and its resources to be stopped/inspected before a new
authority starts, forbid importing live handles/state, and describe rollback and
manual quarantine acknowledgement without deleting durable evidence.

#### Scenario: Replace the native host
- **WHEN** an operator follows the cutover guide
- **THEN** new controller scopes and approvals are created only after old authority
  is stopped, with no automatic adoption or restored previous-host approvals
