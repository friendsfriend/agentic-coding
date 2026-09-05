# workflow-state-runtime Specification

## Purpose
Provides one validated, transactional authority for workflow commands, state, audit events, and recoverable external effects so crashes and concurrency cannot create impossible lifecycle state.
## Requirements
### Requirement: Unified command processing
Every workflow mutation SHALL pass through one command-processing contract that validates command shape, actor authority, required developer revision or active run generation, current workflow state, step legality, and resulting state before commit. The contract SHALL recognize developer-only `request-research-wiki` at `core.research` and `close-research` at any active research, wiki drafting, or wiki approval step in the pinned `research` definition.

#### Scenario: Valid command executes
- **WHEN** an authorized actor submits a command valid for the current step and revision
- **THEN** the engine SHALL reduce the command against the current snapshot
- **AND** the engine SHALL validate the resulting snapshot before committing it

#### Scenario: Research wiki request executes transactionally
- **WHEN** the developer submits a valid `request-research-wiki` action against an active research workflow revision
- **THEN** the engine SHALL expire the researcher run, enqueue the required stop effect, transition to `core.wiki`, and commit the state/event/effects atomically

#### Scenario: Research close executes transactionally
- **WHEN** the developer submits a valid `close-research` action against an active research workflow revision at any non-terminal step
- **THEN** the engine SHALL expire active research runs, enqueue required stop effects, transition to `core.closed`, and commit the state/event/effects atomically

#### Scenario: Research close does not require an agent handoff
- **WHEN** the researcher runtime is unavailable or has settled without handoff
- **THEN** a valid `close-research` action SHALL still be able to close the workflow
- **AND** the engine SHALL not infer closure from the runtime state itself

#### Scenario: Command is invalid
- **WHEN** a command has invalid payload, stale revision, unauthorized actor, expired run, illegal outcome, or is unavailable in the current step
- **THEN** the engine SHALL reject the command before mutation
- **AND** persisted snapshot, audit history, and pending effects SHALL remain unchanged

### Requirement: Optimistic concurrency
Persisted workflows SHALL carry monotonically increasing revision used for developer/operator commands, while agent handoffs SHALL bind to one active run generation so parallel runs can complete across intervening revisions.

#### Scenario: Two callers use same revision
- **WHEN** two commands target same workflow revision concurrently
- **THEN** at most one command SHALL commit
- **AND** losing command SHALL return current revision without overwriting winner

#### Scenario: Parallel run handoffs arrive
- **WHEN** distinct active runs created by same step submit across intervening workflow revisions
- **THEN** each SHALL commit against latest snapshot if its run generation remains active
- **AND** prior results SHALL not be overwritten

#### Scenario: Duplicate run handoff arrives
- **WHEN** already-consumed run capability is submitted again
- **THEN** engine SHALL reject duplicate as stale
- **AND** successor runs or effects SHALL NOT be created twice

### Requirement: Atomic state, event, and outbox commit
A successful command SHALL atomically persist the new validated snapshot, audit event, and requested external effects before those effects execute. This SHALL include direct research closure and expiration of its active researcher ownership.

#### Scenario: Transaction fails
- **WHEN** the snapshot, event, or outbox write fails
- **THEN** none of the three SHALL commit
- **AND** no external effect SHALL start for the failed command

#### Scenario: Research close cannot partially apply
- **WHEN** one stop-effect enqueue or active-run expiration fails while processing `close-research`
- **THEN** the workflow SHALL not commit a terminal snapshot with only some researcher ownership removed
- **AND** the transaction SHALL roll back for retry or operator attention

#### Scenario: Process exits after commit
- **WHEN** a command commits but the process exits before a requested effect completes
- **THEN** the workflow SHALL expose the pending effect rather than falsely report effect completion
- **AND** later engine execution SHALL resume the pending effect

### Requirement: Idempotent external effects
Every external effect SHALL have a stable idempotency key, durable status, bounded automatic execution attempts, and a handler that can determine whether requested work already completed. A claim SHALL consume an attempt, including claims recovering expired execution. Automatic recovery SHALL NOT exceed the stored attempt budget.

#### Scenario: Effect is retried
- **WHEN** effect execution is interrupted or returns a retryable error
- **THEN** the engine SHALL retry the same effect identity without duplicating completed external work
- **AND** the workflow view SHALL expose retry state and the latest error

#### Scenario: Effect cannot safely retry
- **WHEN** an effect exhausts attempts or completion cannot be established safely
- **THEN** the workflow SHALL enter attention-required state
- **AND** the engine SHALL NOT advance by assuming success

#### Scenario: Expired execution has exhausted its budget
- **WHEN** a running effect's lease expires after its final permitted automatic claim
- **THEN** the next recovery pass SHALL record failure and operator attention without executing another attempt
- **AND** the effect identity and diagnostic SHALL remain available for explicit operator recovery

#### Scenario: Operator explicitly retries a failed effect
- **WHEN** an authorized operator accepts the current revision's retry action
- **THEN** the engine SHALL grant a new explicitly bounded retry budget while retaining the stable effect identity
- **AND** expired ownership from the previous budget SHALL remain invalid

### Requirement: Single canonical workflow store
The system SHALL use one canonical repository SQLite store for workflow authority and SHALL resolve same store from main checkout or linked worktree. Each workflow row SHALL be keyed by the user-supplied workflow identifier; the change identifier SHALL be recorded during the plan step from the planner-declared primary change rather than required at workflow start.

#### Scenario: Command runs from linked worktree
- **WHEN** command is invoked inside workflow worktree
- **THEN** engine SHALL resolve repository's canonical store
- **AND** it SHALL read and write same row used by dashboard in main repository

#### Scenario: Workflow is persisted
- **WHEN** snapshot changes
- **THEN** engine SHALL write only canonical store
- **AND** it SHALL NOT maintain writable state mirrors in worktree

#### Scenario: Workflow row is keyed by workflow identifier
- **WHEN** a workflow is started with a user-supplied workflow identifier
- **THEN** the canonical store row SHALL be keyed by that workflow identifier
- **AND** the stored change identifier SHALL be empty until the plan step records the planner-declared primary change

### Requirement: Runtime state validation
The system SHALL validate stored schema version, required fields, definition pin, revision, current step, runs, routing, and cross-field invariants on every load and before every write.

#### Scenario: Persisted row is malformed
- **WHEN** stored row fails schema or cross-field validation
- **THEN** engine SHALL fail closed with diagnostic identifying invalid fields or invariant
- **AND** no command or effect SHALL proceed from malformed state

#### Scenario: State mutation produces invalid state
- **WHEN** reducer output violates pinned workflow definition or run invariants
- **THEN** transaction SHALL roll back
- **AND** engine SHALL report reducer contract failure

### Requirement: Safe legacy migration
The system SHALL automatically migrate recognized legacy workflow rows to canonical schema on first access while preserving valid domain data and recording migration event.

#### Scenario: Equivalent legacy mirrors exist
- **WHEN** valid legacy workflow has equivalent repository and worktree rows
- **THEN** engine SHALL map phase and verification state to pinned built-in step definition
- **AND** commit canonical migrated snapshot with revision and migration audit event
- **AND** stop relying on legacy mirror

#### Scenario: Active legacy agent cannot use new protocol
- **WHEN** migration maps active legacy work to an agent step
- **THEN** engine SHALL expire legacy agent ownership and enqueue fresh run assignment using new protocol
- **AND** stale legacy completion SHALL NOT mutate migrated workflow

#### Scenario: Legacy sources conflict or cannot map
- **WHEN** legacy mirrors disagree or legacy data cannot map unambiguously to valid step state
- **THEN** migration SHALL fail closed into repair-required view
- **AND** engine SHALL preserve source data for diagnosis rather than choosing arbitrary version

### Requirement: Run-bound artifact validation
Agent-produced output SHALL be accepted only from declared output path for active run and after size, schema, run identity, and content digest validation. Plan-step completion SHALL additionally validate that the planner-declared primary change directory exists and is complete before recording it as the workflow's change identifier.

#### Scenario: Valid output artifact is submitted
- **WHEN** active run submits declared artifact satisfying pinned output contract
- **THEN** engine SHALL store artifact digest with completion event
- **AND** reducer SHALL receive validated parsed output

#### Scenario: Artifact is stale or outside assignment
- **WHEN** handoff references another run's artifact, path outside assigned workflow area, oversized content, or schema mismatch
- **THEN** handoff SHALL fail without consuming run capability
- **AND** engine SHALL NOT infer outcome from file existence alone

#### Scenario: Plan declares primary change
- **WHEN** the plan step completes and declares a primary change identifier
- **THEN** the engine SHALL validate that the named primary change directory exists and is complete
- **AND** it SHALL reject the completion when the primary change is missing, incomplete, or undeclared

### Requirement: Renewable exclusive effect ownership
Effect execution SHALL require a matching unexpired lease on a running effect. Claiming, renewal, liveness checks, and completion acceptance SHALL use the same engine clock and validity rules. Renewal SHALL extend only still-valid ownership and SHALL NOT revive an expired or replaced lease.

#### Scenario: Long operation retains ownership
- **WHEN** a live handler exceeds the initial lease duration while its renewal requests succeed
- **THEN** its lease SHALL remain valid until completion or its bounded execution deadline
- **AND** its completion SHALL be accepted once without another runner reclaiming it

#### Scenario: Expired owner attempts renewal or completion
- **WHEN** an owner submits renewal or a result after expiry, replacement, or workflow cancellation
- **THEN** the engine SHALL reject it without changing the successor's ownership or advancing the workflow

#### Scenario: Competing runners claim the same effect
- **WHEN** two runners concurrently request executable work
- **THEN** at most one SHALL obtain valid ownership of a particular effect
- **AND** the losing runner SHALL not execute that effect under the winner's lease

### Requirement: Execution capacity and cancellation respect leases
The serial runner SHALL claim an effect only when it can begin processing it. Long-running subprocess operations SHALL be asynchronous and bounded so renewal can run, and ownership loss SHALL prevent initiation of further external work by that execution.

#### Scenario: Slow effect precedes another effect
- **WHEN** one effect occupies the serial runner for longer than a lease interval
- **THEN** later unstarted effects SHALL remain unclaimed and SHALL not consume attempts while waiting

#### Scenario: Ownership is lost during execution
- **WHEN** renewal fails or repair replaces active ownership
- **THEN** the runner SHALL stop initiating further work and cancel its owned subprocess where supported
- **AND** cleanup SHALL not destroy resources adopted by the successor execution

#### Scenario: Process crashes after external success
- **WHEN** an external operation completes but its owner exits before committing the result
- **THEN** a permitted recovery attempt SHALL observe existing completion before executing again
- **AND** uncertain or exhausted recovery SHALL require attention rather than assuming success

