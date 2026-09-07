## ADDED Requirements

### Requirement: Version-matched Effect programming conventions
The workflow package SHALL lock a supported Effect release compatible with its Bun runtime, TypeScript compiler, and compiled binary. Agent-facing examples SHALL use APIs from that release and SHALL be checked by the package's existing type-check or test commands.

#### Scenario: Example uses an incompatible API
- **WHEN** a documented executable example references an Effect API absent from the locked release
- **THEN** the focused example check or type check SHALL fail before release

#### Scenario: Runtime is built
- **WHEN** the workflow binary is built with locked dependencies
- **THEN** a compiled workflow command SHALL start and execute a representative Schema operation without an unresolved runtime dependency

### Requirement: Expected workflow failures have typed recovery distinctions
Effect-facing workflow operations SHALL expose concrete tagged expected failures for their supported recovery choices. Unexpected defects and interruption SHALL remain distinct from ordinary retryable failures. External formatting SHALL retain stable workflow diagnostic codes, relevant revision information, and bounded redacted messages.

#### Scenario: Stale revision is rejected
- **WHEN** an operation fails because its developer revision is stale
- **THEN** the failure SHALL expose a typed stale-revision distinction and current revision without requiring message matching
- **AND** the external diagnostic SHALL retain the corresponding workflow code

#### Scenario: Unexpected defect occurs
- **WHEN** an operation encounters a programming defect outside its declared expected failures
- **THEN** it SHALL remain distinguishable from a transient infrastructure failure
- **AND** it SHALL not become automatically retryable through a generic error conversion

#### Scenario: Error contains sensitive input
- **WHEN** a failure originates from a credential or capability-bearing request
- **THEN** its default external diagnostic SHALL omit raw secrets and bound included details

### Requirement: Agent guidance defines one workflow implementation path
Repository instructions SHALL link a workflow Effect playbook containing checked examples for operations, errors, schemas, services, scopes, and tests. The playbook SHALL distinguish durable outbox effects from Effect programs, preserve pure step behavior, and identify allowed native/Promise boundaries and outer runtime owners.

#### Scenario: Agent adds an external handler
- **WHEN** an agent follows repository instructions to add a workflow handler
- **THEN** it SHALL find a production-backed example of typed failure handling, cancellation, cleanup, and a focused test
- **AND** the guidance SHALL not require inventing a custom async or service framework

### Requirement: Migration coverage and agent outcomes are recorded
The migration SHALL maintain an explicit module/caller inventory with phase owners and migration-only bridge removal conditions. It SHALL record a baseline and final comparison for adding a cancellable handler and extending a validated command with pure step behavior, including model/version, prompts, supplied instructions, verification results, and human corrections.

#### Scenario: Temporary bridge is introduced
- **WHEN** a migration phase retains a compatibility facade for an unmigrated caller
- **THEN** the inventory SHALL name the exact facade, caller, removal phase, and removal check

#### Scenario: Agent performance does not improve
- **WHEN** the representative task comparison shows regressions or inconclusive results
- **THEN** the record SHALL report that outcome rather than claim guaranteed productivity improvement
- **AND** all correctness and compatibility checks SHALL remain mandatory
