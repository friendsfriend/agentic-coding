## ADDED Requirements

### Requirement: Step-owned completion decisions
Step-specific agent and effect completion decisions SHALL be declared through the existing registered step behavior mechanism and resolved using the workflow's pinned step version. The engine SHALL authenticate completion facts before invoking behavior and SHALL validate/apply declarative results atomically. Generic handoff/effect-result orchestration SHALL not maintain duplicate step-ID decision tables for these completion semantics.

#### Scenario: Verification completion aggregates results
- **WHEN** an authorized verification run completes
- **THEN** registered verification behavior SHALL preserve prior valid parallel results and determine whether to wait, request the one-time test verifier, pass, request fixes, or reach the existing round limit
- **AND** the result SHALL match the prior implementation for every supported handoff order

#### Scenario: Fusion planners complete out of order
- **WHEN** authorized fusion planners submit validated drafts in different orders or retry after partial completion
- **THEN** registered fusion behavior SHALL preserve surviving drafts and transition only when all required planner outputs are valid
- **AND** it SHALL not relaunch a role whose valid result survives the retry

#### Scenario: Planning completion requires external validation
- **WHEN** planning or consolidation accepts its declared primary change and completion evidence
- **THEN** registered behavior SHALL request the existing OpenSpec validation effect
- **AND** the workflow SHALL advance only after the corresponding accepted validation result

#### Scenario: Delivery effects complete
- **WHEN** a valid delivery commit or push effect result is accepted
- **THEN** registered delivery behavior SHALL request the existing next effect or completion transition exactly once
- **AND** global workspace cleanup and effect ownership rules SHALL remain engine-owned

### Requirement: Completion behavior cannot bypass runtime safety
Completion behavior SHALL receive validated facts and explicit state, not database, filesystem, process, network, or clock access. Its declared changes SHALL be limited to permitted local state, legal transition outcomes, authorized run requests, and allowlisted effects. Revision, capability, run identity, evidence, lease, and transaction enforcement SHALL remain in the runtime.

#### Scenario: Unauthorized completion is submitted
- **WHEN** completion has an invalid capability, inactive run generation, invalid evidence, stale developer revision, or expired effect lease
- **THEN** the runtime SHALL reject it before invoking completion behavior
- **AND** state, run ownership, and pending effects SHALL remain unchanged

#### Scenario: Behavior requests a forbidden mutation
- **WHEN** completion behavior requests an illegal transition, unrouted run, forbidden effect, or change to engine-owned identity
- **THEN** runtime validation SHALL reject the result and roll back all command writes

#### Scenario: Persistence fails after behavior evaluation
- **WHEN** a run, snapshot, event, or outbox write fails after a valid completion decision
- **THEN** the transaction SHALL roll back including capability consumption
- **AND** no requested external work SHALL execute from the failed command
