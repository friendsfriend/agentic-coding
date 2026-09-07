## ADDED Requirements

### Requirement: Scoped execution supervises lease renewal
Each claimed outbox execution SHALL have one Effect-owned scope supervising observation, execution, and lease renewal. The serial runner SHALL claim only immediately executable work. Renewal rejection or failure SHALL stop new external work and interrupt owned operations; completion SHALL still require transactional validation of the current unexpired lease.

#### Scenario: Renewal raises an infrastructure failure
- **WHEN** the renewal operation fails while a handler is active
- **THEN** the execution SHALL stop initiating work and begin bounded ownership-aware cancellation
- **AND** the failure SHALL remain observable rather than escape as an unhandled timer error

#### Scenario: Lease changes before result commit
- **WHEN** ownership is replaced after external work finishes but before result acceptance
- **THEN** the old execution SHALL not commit completion under its invalid lease
- **AND** cleanup SHALL not destroy successor-owned resources

### Requirement: Scoped cleanup distinguishes temporary and durable ownership
Execution scopes SHALL clean up their temporary resources on success, failure, or interruption. Managed agents, panes, and workspaces intentionally owned by the durable workflow SHALL survive successful execution-scope exit. Failure/ownership-loss cleanup SHALL respect explicit identity and ownership transfer, with uncertain ownership requiring reconciliation rather than destructive assumptions.

#### Scenario: Agent launch succeeds
- **WHEN** a launched agent becomes the recorded live workflow run and the drain exits
- **THEN** scope finalization SHALL release temporary launch resources without stopping the durable agent

#### Scenario: Reused pane launch fails
- **WHEN** an execution fails while using a pane it did not create or no longer owns
- **THEN** cleanup SHALL not close that pane

#### Scenario: Temporary resource acquisition is interrupted
- **WHEN** interruption occurs after a temporary file, descriptor, reader, or child has been acquired
- **THEN** registered cleanup SHALL release that resource within a documented bound
- **AND** cleanup failure SHALL remain observable without converting the execution into success

### Requirement: Effect recovery obeys durable failure policy
Persisted outbox identity, claim counts, attempt limits, retry timestamps, and operator retry budgets SHALL remain authoritative. Confirmed transient failures SHALL request durable retry; known permanent failures SHALL require attention without unnecessary transient retries. Ownership loss, interruption, defects, and uncertain external completion SHALL not be silently converted into retryable ordinary errors. Generic Effect retry SHALL not re-execute a mutating handler outside durable accounting.

#### Scenario: Handler fails transiently
- **WHEN** a safe retryable handler failure occurs under a valid lease with budget remaining
- **THEN** the runner SHALL persist the retry through the engine and wait for the stored deadline before a new claim
- **AND** each re-execution SHALL consume a persisted attempt

#### Scenario: Configuration is permanently invalid
- **WHEN** a handler reports a known permanent configuration failure
- **THEN** the engine SHALL record failure and attention without consuming additional automatic attempts

#### Scenario: Observation cannot establish remote state
- **WHEN** a recovery observation fails to distinguish completed work from absent work
- **THEN** the runner SHALL not treat that failure as confirmation that mutating work should be repeated
- **AND** it SHALL retain an actionable recovery diagnostic

### Requirement: Effect interruption reaches external resources
Workflow process and credential adapters SHALL propagate interruption to owned subprocesses and pending credential operations, and SHALL bound output collection, FIFO waits, and cleanup. Cancelling an Effect wait without cancelling the owned external operation SHALL not satisfy this requirement. Credential contents SHALL not be persisted or emitted in diagnostics/telemetry.

#### Scenario: Lease is lost while credentials are pending
- **WHEN** a credential-bearing command loses ownership before the developer answers
- **THEN** the command, owned relay readers/writers, and pending prompt SHALL be cancelled or resolved within their documented bounds
- **AND** late answers SHALL not revive execution or be retained for another request

#### Scenario: Subprocess reaches its deadline
- **WHEN** an owned subprocess exceeds its configured deadline
- **THEN** the adapter SHALL report timeout distinctly, terminate the owned process according to its supported termination policy, and clean up its readers

### Requirement: External workflow context is operation-local
Workflow wiki roots and child execution settings SHALL be supplied explicitly or through immutable operation-local Effect services. Concurrent workflow operations SHALL not communicate their settings through temporary mutation of process-wide environment. Existing pinned-root and secure filesystem constraints SHALL remain enforced.

#### Scenario: Different wiki roots overlap
- **WHEN** two operations with different authorized pinned wiki roots overlap in one process
- **THEN** each SHALL read/write only its own root and child environment
- **AND** neither SHALL temporarily modify process.env to select its root

#### Scenario: Secure path is replaced with a symlink
- **WHEN** an attacker substitutes a protected runtime path component during file acquisition/publication
- **THEN** the Effect filesystem boundary SHALL retain the established no-follow and descriptor-relative protections rather than follow the substituted path
