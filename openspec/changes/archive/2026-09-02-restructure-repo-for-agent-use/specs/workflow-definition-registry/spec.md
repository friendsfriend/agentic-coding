## MODIFIED Requirements

### Requirement: Registered step contract
The system SHALL represent every workflow step as a registered, versioned definition with a stable identifier, actor kind, input and output contract, permitted outcomes, entry and completion validation, instruction assets when applicable, allowlisted external effects, and a declarative step behavior block that carries the step's own engine-internal semantics. The behavior block SHALL NOT contribute to the step digest or the workflow definition digest, so declaring or changing behavior SHALL NOT invalidate any existing pinned workflow.

#### Scenario: Built-in step is registered
- **WHEN** engine initializes its built-in step catalog
- **THEN** every step SHALL expose all required contract fields
- **AND** no command handler SHALL provide an unregistered lifecycle path around the step contract

#### Scenario: Step output is incompatible
- **WHEN** a run submits output that does not satisfy its pinned step output contract
- **THEN** engine SHALL reject completion without changing workflow state
- **AND** rejection SHALL identify the failed contract

#### Scenario: Behavior is declared without moving a digest
- **WHEN** the built-in step catalog is registered with declared step behavior
- **THEN** every registered workflow definition digest and every step digest SHALL be identical to the value produced before behavior was declared
- **AND** an existing workflow pinned to that definition SHALL continue to dispatch without repair or migration

#### Scenario: Behavior declares no agent roles for an agent step
- **WHEN** a step whose actor kind is `agent` is registered with a behavior block that resolves to no roles
- **THEN** registration SHALL be rejected identifying the offending step
- **AND** no partially registered catalog SHALL be exposed

## ADDED Requirements

### Requirement: Step-owned agent role selection
Agent role selection for a step SHALL be a property of that step's registered definition and SHALL have exactly one source of truth. The engine, the command-line surface, and the dashboard SHALL each read roles from the registered step definition rather than deriving, duplicating, or re-implementing role logic. Resolution MAY depend only on the workflow snapshot supplied to it — its pinned definition identity and its resolved routing — so the same step and snapshot SHALL always resolve the same roles regardless of which consumer asks.

#### Scenario: Every consumer resolves the same roles
- **WHEN** the engine, the command-line surface, and the dashboard each resolve roles for the same step of the same workflow
- **THEN** all three SHALL return the identical ordered role list
- **AND** no consumer SHALL contain its own role table

#### Scenario: Roles remain definition-sensitive
- **WHEN** roles are resolved for a step whose role list depends on the pinned definition
- **THEN** verification for the `no-openspec` definition SHALL omit the OpenSpec verifier role while other definitions retain it
- **AND** wiki drafting for the `research` definition SHALL resolve the research wiki drafting role while other definitions resolve the standard wiki role

#### Scenario: Roles remain routing-sensitive
- **WHEN** roles are resolved for the fusion planning step of a workflow whose routing configures a planner count
- **THEN** the resolved roles SHALL be exactly the configured number of distinct planner roles
- **AND** changing the configured planner count SHALL change the resolved roles without any consumer change

#### Scenario: Registered step is missing its behavior
- **WHEN** a workflow manifest references a registered step for which no behavior is declared
- **THEN** registry construction SHALL fail identifying the step
- **AND** the failure SHALL occur at catalog construction rather than when a workflow reaches that step
