## ADDED Requirements

### Requirement: Final Effect cutover has focused compatibility gates
Cutover verification SHALL cover compiled CLI behavior, in-process dashboard operations, read-only observation, explicit execution progress, pending-work restart, internal runtime boundaries, and supported historical data/pins. Real-process and real-store checks SHALL complement fake-service/virtual-time checks. Internal API fixture changes SHALL not substitute for unchanged external behavior oracles.

#### Scenario: Internal export fixture changes
- **WHEN** migration changes internal engine symbols or signatures
- **THEN** their fixture update SHALL be reviewed as an intentional internal API change
- **AND** independent CLI/JSON, persistence, semantic pin, and security checks SHALL still pass

#### Scenario: Final binary reopens pending work
- **WHEN** the built binary opens a compatible pre-migration workflow with pending effects
- **THEN** it SHALL recover using existing identities and pins without an Effect-specific store migration or repin

### Requirement: Agent recipes are checked against the finished implementation
Final agent guidance SHALL provide production-backed, type-checked examples for a cancellable handler with typed transient failure and a validated command with pure step behavior. The migration SHALL repeat its baseline agent tasks and record verification results, human corrections, model/instruction differences, and observed regressions or uncertainty without presenting them as guaranteed gains.

#### Scenario: Documented recipe drifts
- **WHEN** a production API change invalidates an executable agent recipe
- **THEN** its focused check SHALL fail until guidance and implementation agree

#### Scenario: Agent task violates durable retry policy
- **WHEN** an evaluated agent implementation retries a mutating handler outside persisted attempt accounting
- **THEN** the focused correctness check/review SHALL reject that implementation
- **AND** the evaluation SHALL record the required correction rather than count an unchecked generated patch as success
