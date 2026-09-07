## ADDED Requirements

### Requirement: Scoped Effect store access preserves SQL atomicity
Effect store operations SHALL own acquired SQLite handles through scoped cleanup. Each workflow write transaction SHALL execute its validation, reduction, writes, and commit/rollback as one non-suspending synchronous critical section. Asynchronous external work, nested runtime execution, sleeps, and retry schedules SHALL not execute inside that section.

#### Scenario: Mutation is interrupted
- **WHEN** interruption is requested around a workflow transaction
- **THEN** it SHALL be observed before transaction entry or after the synchronous atomic section rather than between its writes
- **AND** the handle SHALL close after commit or rollback

#### Scenario: Transaction write fails
- **WHEN** a state, event, or outbox write fails before successful commit
- **THEN** all workflow transaction writes SHALL roll back and no external effect SHALL begin from that transaction
- **AND** scoped cleanup SHALL release the handle

### Requirement: Post-commit failure does not imply rollback
A command committed before interruption, notification failure, or caller disconnect SHALL remain committed and recoverable. The application SHALL not automatically replay the mutation or report that its durable writes were rolled back. An uncertain commit outcome SHALL require reread/reconciliation rather than blind mutation retry.

#### Scenario: Continuation fails after commit
- **WHEN** a command commits but its continuation request fails
- **THEN** its revision/event/outbox SHALL remain present exactly once
- **AND** later explicit execution SHALL be able to recover pending effects

### Requirement: Effect time remains consistent with durable ownership
Claims, renewal, liveness, command-time expiry validation, and runner scheduling SHALL use one production/test clock model. Transaction-time ownership decisions SHALL use a current timestamp sampled after acquiring the writer lock, not an arbitrarily stale preparation timestamp.

#### Scenario: Writer contention crosses lease expiry
- **WHEN** an ownership operation waits for the writer lock until its lease has expired
- **THEN** its transaction-time validation SHALL reject the expired ownership rather than renew it using an earlier timestamp

#### Scenario: Controlled time advances
- **WHEN** a test advances the shared clock beyond a lease or question deadline
- **THEN** application validation and scheduled operations SHALL agree on whether the deadline has passed

### Requirement: Effect evidence preparation retains transactional authorization
Effect-based evidence preparation SHALL preserve existing bounded artifact capture, source/run binding, secure filesystem access, and transactional reauthorization. It SHALL not consume capabilities before successful validation, weaken source fingerprint scope, or impose exact developer-revision semantics on independent active agent runs.

#### Scenario: Artifact is replaced during preparation
- **WHEN** assigned evidence or its bound source changes before acceptance
- **THEN** the runtime SHALL reject or securely reprepare it according to the established evidence policy
- **AND** no unvalidated output SHALL commit

#### Scenario: Sibling run commits first
- **WHEN** another valid parallel run advances the revision while evidence is prepared
- **THEN** the current run SHALL be reauthorized against current state and its active generation rather than rejected solely for the sibling's revision change

#### Scenario: Observer accesses an old store
- **WHEN** an Effect status/list/view operation opens an absent or unsupported-old store
- **THEN** it SHALL return the established absent or migration-required diagnostic without initialization, import, expiry mutation, or effect claims
