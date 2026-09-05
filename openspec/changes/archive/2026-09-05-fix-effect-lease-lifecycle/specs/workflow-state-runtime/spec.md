## MODIFIED Requirements

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

## ADDED Requirements

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
