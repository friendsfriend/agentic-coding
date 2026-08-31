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
Every external effect SHALL have stable idempotency key, durable status, bounded attempts, and handler that can determine whether requested work already completed.

#### Scenario: Effect is retried
- **WHEN** effect execution is interrupted or returns retryable error
- **THEN** engine SHALL retry same effect identity without duplicating completed external work
- **AND** workflow view SHALL expose retry state and latest error

#### Scenario: Effect cannot safely retry
- **WHEN** effect exhausts attempts or completion cannot be established safely
- **THEN** workflow SHALL enter attention-required state
- **AND** engine SHALL NOT advance by assuming success

### Requirement: Single canonical workflow store
The system SHALL use one canonical repository SQLite store for workflow authority and SHALL resolve same store from main checkout or linked worktree.

#### Scenario: Command runs from linked worktree
- **WHEN** command is invoked inside workflow worktree
- **THEN** engine SHALL resolve repository's canonical store
- **AND** it SHALL read and write same row used by dashboard in main repository

#### Scenario: Workflow is persisted
- **WHEN** snapshot changes
- **THEN** engine SHALL write only canonical store
- **AND** it SHALL NOT maintain writable state mirrors in worktree

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
Agent-produced output SHALL be accepted only from declared output path for active run and after size, schema, run identity, and content digest validation.

#### Scenario: Valid output artifact is submitted
- **WHEN** active run submits declared artifact satisfying pinned output contract
- **THEN** engine SHALL store artifact digest with completion event
- **AND** reducer SHALL receive validated parsed output

#### Scenario: Artifact is stale or outside assignment
- **WHEN** handoff references another run's artifact, path outside assigned workflow area, oversized content, or schema mismatch
- **THEN** handoff SHALL fail without consuming run capability
- **AND** engine SHALL NOT infer outcome from file existence alone

