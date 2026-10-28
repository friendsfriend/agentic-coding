## ADDED Requirements

### Requirement: Discoverable revision-bound recovery
The system SHALL expose precise recovery eligibility in compact and full workflow status and through a read-only orchestrator preview. Preview SHALL identify the revision, source and supported target, affected runs/tasks/effects, retirement consequences, retained evidence, review consequences, required inputs and refusal reasons. Execution SHALL require the inspected current revision and preview identity, an eligible operation/target, a trimmed reason of 1–160 characters and an instruction of 1–8,000 characters. Invalid or stale input MUST fail without mutation.

#### Scenario: Blocked worker without a question
- **WHEN** an orchestrator-owned workflow is attention-required with a terminal blocked implementation worker, no pending question and legacy availableActions empty
- **THEN** status advertises same-step recovery with required fields and preview shows a fresh implementation attempt rather than paused-only resume or answering a nonexistent question

#### Scenario: Stale or mismatched preview
- **WHEN** revision changes after inspection or execution selects a target not bound to its preview
- **THEN** execution is rejected without creating a run, audit success or launch effect

#### Scenario: Unsupported structural target
- **WHEN** a caller requests an unknown, system, terminal or otherwise incompatible repair target or unsupported integrity repair
- **THEN** preview/execution reports the limitation and no repair occurs

### Requirement: Scoped server-side authority
Recovery SHALL be permitted for the authenticated home orchestrator only on workflows durably started by the orchestrator and resolved through its existing visible workflow target catalog. Server-derived principal SHALL be used for authorization and attribution. Tool, action and direct route calls SHALL enforce the same recovery authority; worker agents and other unauthorized clients MUST NOT gain repair privileges. Authenticated developer repair access SHALL remain available within the same current-agent-step safety constraints; legacy arbitrary cross-step and live-worker replacement SHALL be refused.

#### Scenario: Unauthorized caller or workflow
- **WHEN** a worker, unauthenticated/unauthorized HTTP client, or orchestrator targeting a hidden, mismatched or non-owned workflow attempts repair directly or through tools
- **THEN** the server refuses before mutation and a caller-supplied actor cannot change that result

### Requirement: Durable corrective input and preserved history
Accepted recovery SHALL persist the bounded reason, masked corrective instruction, server-derived orchestrator attribution, source/target, revision, affected records and review consequences in durable audit/context records. It SHALL preserve prior failures, outcomes and evidence and render the instruction into the replacement worker's actual input. Instructions SHALL be scoped to the intended replacement attempt and survive restart.

#### Scenario: End-to-end blocked-worker recovery
- **WHEN** the orchestrator inspects the isolated blocked/no-question fixture and submits current revision, reason and concrete API references as instruction
- **THEN** the worker is retried at the same correct step with that instruction in its actual assignment, normal execution is requested, prior blocked outcome remains recorded, and no human resume or paste is needed

#### Scenario: Restart before worker launch
- **WHEN** the process restarts after committing recovery but before launching the replacement
- **THEN** the instruction and actor remain auditable and the replacement receives the instruction exactly as scoped without requiring chat memory

#### Scenario: Structural integrity recovery
- **WHEN** an isolated missing/non-active current-run reference or absent-current-attempt defect has an eligible current-agent-step target and the orchestrator executes the inspected repair
- **THEN** the existing repair engine restores that target through normal effects and records retired runs/tasks/effects and retained history without manual storage edits

### Requirement: Human review and evidence invariants
Recovery SHALL NOT approve, reject, skip or fabricate a human plan, developer, findings or wiki decision. This initial release SHALL reject every cross-step repair, including direct operator commands, and SHALL refuse recovery at non-agent review/system steps. Same-step retry SHALL retain arrival context/mode and evidence and SHALL leave subsequent human reviews to ordinary graph transitions. Classifier gate decisions MUST NOT be treated as artifact-bound human approvals; no unsupported approval-validity ledger or producer rewind SHALL be introduced.

#### Scenario: Skip-ahead attack
- **WHEN** a caller directly requests repair beyond an unsatisfied human gate, including from a non-review current step
- **THEN** engine validation rejects it without advancing the workflow or fabricating evidence

#### Scenario: Technical review recovery
- **WHEN** recovery is requested at a human review wait
- **THEN** recovery is refused, the undecided wait remains unchanged, and no approval or rejection is generated

#### Scenario: Artifact producer rewind
- **WHEN** a caller requests return to another producer step, with either changed or unchanged artifacts
- **THEN** the cross-step request is refused without reusing or invalidating any human decision; only current-step work can be retried and all later reviews remain mandatory graph transitions

### Requirement: Race-safe bounded execution
Recovery SHALL use existing transactional revision, run lifecycle and durable outbox mechanisms, not a parallel state machine. It SHALL refuse unsafe replacement while relevant workers/debug runs are live or launch/prompt effects are leased. Claims/publication SHALL be fenced against retired attempts. Repeated or concurrent requests SHALL produce at most one replacement and normal execution dispatch. Recovery SHALL remain explicit and SHALL NOT loop automatically.

#### Scenario: Duplicate request
- **WHEN** two callers execute the same inspected revision or a caller repeats a successful request
- **THEN** at most one fresh attempt and launch effect is created and remaining requests fail stale or report the already accepted result without dispatch duplication

#### Scenario: Active-run or lease race
- **WHEN** a worker/debug run is active or an effect claim races with recovery
- **THEN** recovery refuses unsafe replacement or the normal claim fence prevents the retired attempt from launching/publishing, without concurrent replacement execution or lease theft

### Requirement: Accurate guidance and regression protection
Tools, schemas, status and documentation SHALL describe only supported recovery, scope and limitations. Operational clarification from agreed work SHALL be permitted; ambiguous new scope, architecture or permissions SHALL be forwarded to the developer. Recovery SHALL NOT authorize configuration/credential edits, deletion, manual DB surgery, force merge, destructive reset or native-file circumvention. Existing question answer/forward, pause/resume, retry-effect and switch-preset SHALL retain their behavior.

#### Scenario: Existing management behavior
- **WHEN** isolated fixtures exercise routed own-question answer/forward and existing pause/resume, retry-effect and switch-preset operations
- **THEN** their previous authorization, revision and execution semantics remain intact and descriptions distinguish them from recovery

#### Scenario: Remaining blocker
- **WHEN** recovery is refused or a fresh worker remains blocked on a new permission/scope decision
- **THEN** the orchestrator surfaces the bounded diagnostic and forwards the unresolved decision rather than repeatedly repairing or editing around server boundaries
