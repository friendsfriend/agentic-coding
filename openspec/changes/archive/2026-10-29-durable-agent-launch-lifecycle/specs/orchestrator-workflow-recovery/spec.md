## MODIFIED Requirements

### Requirement: Discoverable revision-bound recovery
The system SHALL expose precise recovery eligibility in compact and full workflow status and through a read-only orchestrator preview. Preview SHALL identify the revision, source and supported target, affected runs/tasks/effects, retirement consequences, retained evidence, review consequences, required inputs and refusal reasons. Execution SHALL require the inspected current revision and preview identity, an eligible operation/target, a trimmed reason of 1–160 characters and an instruction of 1–8,000 characters. Invalid or stale input MUST fail without mutation. The supported `reconcile-launch` operation SHALL bind workflow generation, step/attempt, exact affected record states, claim ownership/expiry and fresh authenticated host observation/fencing identity in its preview. Lease renewal or changed admission SHALL invalidate the preview. Preview SHALL expose only non-secret identity and bounded diagnostics.

#### Scenario: Blocked worker without a question
- **WHEN** an orchestrator-owned workflow is attention-required with a terminal blocked implementation worker, no pending question and legacy availableActions empty
- **THEN** status advertises same-step recovery with required fields and preview shows a fresh implementation attempt rather than paused-only resume or answering a nonexistent question

#### Scenario: Stale or mismatched preview
- **WHEN** revision, lease ownership/expiry or host admission changes after inspection or execution selects a target not bound to its preview
- **THEN** execution is rejected without creating a run, audit success or launch effect

#### Scenario: Unsupported structural target
- **WHEN** a caller requests an unknown, system, terminal or otherwise incompatible repair target or unsupported integrity repair
- **THEN** preview/execution reports the limitation and no repair occurs

### Requirement: Scoped server-side authority
Recovery SHALL be permitted for the authenticated home orchestrator only on workflows durably started by the orchestrator and resolved through its existing visible workflow target catalog. Server-derived principal SHALL be used for authorization and attribution. Tool, action and direct route calls SHALL enforce the same recovery authority; worker agents and other unauthorized clients MUST NOT gain repair privileges. Orchestrator recovery SHALL remain current-agent-step only. Authenticated developer manual Repair SHALL preserve the existing compatible multi-target cross-step UI and server contract, distinct from orchestrator recovery, without interrupting working agents or stealing live claims.

#### Scenario: Unauthorized caller or workflow
- **WHEN** a worker, unauthenticated/unauthorized HTTP client, or orchestrator targeting a hidden, mismatched or non-owned workflow attempts repair directly or through tools
- **THEN** the server refuses before mutation and a caller-supplied actor cannot change that result

#### Scenario: Developer target selection remains available
- **WHEN** an authenticated developer opens manual Repair on an eligible workflow
- **THEN** existing compatible nonterminal targets remain selectable, including cross-step review/producer targets, while the orchestrator cannot invoke those cross-step targets

### Requirement: Human review and evidence invariants
Recovery SHALL NOT approve, reject, skip or fabricate a human plan, developer, findings or wiki decision. Orchestrator recovery SHALL reject every cross-step repair and refuse re-entry at non-agent review/system steps. Developer-directed manual cross-step Repair SHALL retain its explicit existing target semantics without synthesizing decisions; re-entered review waits SHALL require the actual human decision. Same-step retry SHALL retain arrival context/mode and evidence and SHALL leave subsequent human reviews to ordinary graph transitions. Classifier gate decisions MUST NOT be treated as artifact-bound human approvals; no unsupported approval-validity ledger or producer rewind automation SHALL be introduced.

#### Scenario: Skip-ahead attack
- **WHEN** an orchestrator or worker directly requests repair beyond an unsatisfied human gate, including from a non-review current step
- **THEN** engine validation rejects it without advancing the workflow or fabricating evidence

#### Scenario: Technical review recovery
- **WHEN** orchestrator recovery is requested at a human review wait
- **THEN** recovery is refused, the undecided wait remains unchanged, and no approval or rejection is generated

#### Scenario: Artifact producer rewind
- **WHEN** an orchestrator requests return to another producer step, with either changed or unchanged artifacts
- **THEN** the cross-step request is refused without reusing or invalidating any human decision; only current-step work can be retried and all later reviews remain mandatory graph transitions

#### Scenario: Explicit developer repair
- **WHEN** a developer explicitly selects an existing compatible cross-step manual Repair target after safety checks
- **THEN** the selected target is entered with preserved history/evidence and no fabricated human outcome, and later review gates retain normal decision semantics

### Requirement: Race-safe bounded execution
Recovery SHALL use existing transactional revision, run lifecycle and durable outbox mechanisms, not a parallel state machine. It SHALL refuse unsafe replacement while relevant workers/debug runs are actually live or effects have valid owner-held leases. A pending run SHALL NOT alone prove execution or absence. An expired/dead claim SHALL be reconciled only through ownership CAS, host admission fencing and exact identity observation, never blanket lease clearing. Matching admitted work SHALL be reconciled in place; verified absent fenced work SHALL use normal durable dispatch. Unavailable or inconclusive host observation SHALL refuse replacement. Claims/publication SHALL be fenced against retired attempts. Repeated or concurrent requests SHALL produce at most one replacement and normal execution dispatch. Recovery SHALL remain explicit and SHALL NOT loop automatically. Only allowlisted obsolete launch/reference integrity defects SHALL enter guarded reconciliation; strict final validation SHALL remain mandatory.

#### Scenario: Duplicate request
- **WHEN** two callers execute the same inspected revision or a caller repeats a successful request
- **THEN** at most one fresh attempt and launch effect is created and remaining requests fail stale or report the already accepted result without dispatch duplication

#### Scenario: Active-run or lease race
- **WHEN** a worker/debug run is active or an effect claim or renewal races with recovery
- **THEN** recovery refuses unsafe replacement or the normal claim fence prevents the retired attempt from launching/publishing, without concurrent replacement execution or lease theft

#### Scenario: Obsolete launch and pending expired claim
- **WHEN** an obsolete failed/retry launch references a retired attempt and the current pending run has a launch claim whose lease expired
- **THEN** preview identifies both, authorized execution fences the expired owner, reconciles existing admission or re-drives verified absent work, retires only obsolete unclaimed records, preserves all outcomes/evidence/audit and resumes validated progression without manual storage edits

#### Scenario: Live lease or unknown remote state
- **WHEN** the current launch has a live owner-held lease or remote admission cannot be determined safely
- **THEN** reconciliation refuses with bounded owner/status and supported next-action guidance, makes no replacement and does not infer non-execution from pending status

#### Scenario: Restart during reconciliation
- **WHEN** a process crashes after host admission/fencing or recovery commit but before acknowledgement/dispatch completion
- **THEN** existing durable identities and ownership fences resume idempotently without duplicate agents or loss of retained evidence
