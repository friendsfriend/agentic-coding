## MODIFIED Requirements

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
