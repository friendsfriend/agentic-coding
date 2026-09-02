# workflow-definition-registry Specification

## Purpose
Defines rigid, versioned workflow and step contracts that remain easy to compose and can later be registered by trusted workflow plugins without changing runtime semantics.

## Requirements

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

### Requirement: Explicit workflow composition
The system SHALL define each workflow as an explicit, versioned graph of registered steps and legal outcomes rather than deriving behavior from phase names or array position. The catalog SHALL include explicit `standard-propose`, `fusion-propose`, `wiki-only`, and `research` graphs that reference the registered steps needed for their respective execution, while excluding implementation, verification, archive, delivery, and pull-request action/effect paths from proposal-only, wiki-only, and research lifecycles.

#### Scenario: Workflow graph is explicit
- **WHEN** a workflow definition is registered
- **THEN** the system SHALL expose its initial step, terminal steps, registered steps, legal outcome targets, declared loops, retry bounds, actor requirements, and requested effects as an explicit validated graph

#### Scenario: Standard proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `standard-propose` SHALL contain `core.plan`, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.plan → core.plan-approval → core.completed → core.closed`
- **AND** its planning `blocked` and `failed` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Fusion proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `fusion-propose` SHALL contain `fusion.plan`, `fusion.consolidate`, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `fusion.plan → fusion.consolidate → core.plan-approval → core.completed → core.closed`
- **AND** its fusion planning and consolidation `blocked` and `failed` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Wiki-only definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `wiki-only` SHALL contain `core.wiki`, `core.wiki-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.wiki → core.wiki-approval → core.completed → core.closed`
- **AND** its documentation and review `blocked`, `failed`, and `comments` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Research definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `research` SHALL contain `core.research`, `core.wiki`, `core.wiki-approval`, and `core.closed`, with `core.research` initial and `core.closed` terminal
- **AND** `core.research` SHALL route to the `researcher` role and require persistent interactive session capabilities
- **AND** the developer-only `request-research-wiki` action SHALL target `core.wiki`, whose successful path SHALL continue through `core.wiki-approval` to `core.closed`
- **AND** the developer-only `close-research` action SHALL be able to terminate an active research workflow before wiki drafting or approval
- **AND** the reachable lifecycle SHALL not include implementation, verification, review, archive, delivery, or pull-request step or effect paths

#### Scenario: Workflow graph is invalid
- **WHEN** a definition contains a missing step, dangling outcome, unreachable terminal, undeclared cycle, unbounded retry, unknown actor, or unavailable effect
- **THEN** registration SHALL fail before any workflow can use that definition
- **AND** a partial definition SHALL NOT remain registered

### Requirement: Explicit extension selection
A registered step or workflow extension SHALL affect only definitions that explicitly reference it.

#### Scenario: Additional step is registered
- **WHEN** a new step becomes available in registry
- **THEN** existing workflow definitions SHALL remain unchanged
- **AND** step SHALL run only in a definition that explicitly includes its stable identifier

#### Scenario: Multiple extensions target same workflow area
- **WHEN** developer composes multiple registered steps around same built-in step
- **THEN** explicit workflow graph order SHALL determine execution
- **AND** engine SHALL NOT infer plugin insertion order from discovery order

### Requirement: Definition pinning
Each workflow SHALL pin exact workflow-definition identifier, version, and digest for its lifetime unless a validated migration changes that pin.

#### Scenario: Workflow starts
- **WHEN** start command accepts a workflow definition
- **THEN** persisted workflow SHALL record exact definition identifier, version, and digest
- **AND** all later commands SHALL evaluate against that pinned definition

#### Scenario: Registry definition changes
- **WHEN** registered definition digest no longer matches active workflow pin
- **THEN** workflow SHALL become blocked before further mutation
- **AND** engine SHALL require matching definition restoration or validated migration rather than reinterpret state

### Requirement: Plugin-grade built-in registry seam
Built-in steps and workflows SHALL register through the same public definition contract reserved for future trusted workflow plugins, while this release SHALL NOT automatically discover or execute external workflow plugin code.

#### Scenario: Built-in workflows initialize
- **WHEN** the engine starts
- **THEN** standard, direct-apply, no-OpenSpec, plan-fusion, standard-propose, fusion-propose, wiki-only, and research definitions SHALL be registered through the public registry contract
- **AND** the engine SHALL validate them identically to later registered definitions

#### Scenario: External package is present
- **WHEN** an unconfigured package or file exports workflow definitions
- **THEN** the engine SHALL NOT load or execute it automatically
- **AND** no filesystem discovery order SHALL affect registered workflows

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
