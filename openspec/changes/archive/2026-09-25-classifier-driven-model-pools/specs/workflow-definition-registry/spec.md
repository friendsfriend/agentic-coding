# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit workflow composition

The system SHALL define each workflow as an explicit, versioned graph of registered steps and legal outcomes rather than deriving behavior from phase names or array position. The catalog SHALL include explicit `openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`, `openspec-fusion-propose`, `wiki`, and `research` graphs that reference the registered steps needed for their respective execution, including the classifier routing pass each OpenSpec family needs, while excluding implementation, verification, archive, delivery, and pull-request action/effect paths from proposal-only, wiki, and research lifecycles.

#### Scenario: Workflow graph is explicit
- **WHEN** a workflow definition is registered
- **THEN** the system SHALL expose its new technical ID, UI label, initial step, terminal steps, registered steps, legal outcome targets, declared loops, retry bounds, actor requirements, and requested effects as an explicit validated graph

#### Scenario: OpenSpec definitions are explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec` SHALL start at `core.route-plan` and route classification to `core.plan` before the standard flow
- **AND** `openspec-apply` SHALL start at `core.route-apply` and route classification to `core.implementation`
- **AND** `openspec-fusion` SHALL start at `core.route-plan` and route classification to `fusion.plan` before consolidation and the standard flow

#### Scenario: Standard proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec-propose` SHALL contain `core.route-plan`, `core.plan`, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.route-plan → core.plan → core.plan-approval → core.completed → core.closed`
- **AND** its planning `blocked` and `failed` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Fusion proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec-fusion-propose` SHALL contain `core.route-plan`, `fusion.plan`, `fusion.consolidate`, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.route-plan → fusion.plan → fusion.consolidate → core.plan-approval → core.completed → core.closed`
- **AND** its fusion planning and consolidation `blocked` and `failed` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Wiki-only definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `wiki` SHALL contain `core.wiki`, `core.wiki-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.wiki → core.wiki-approval → core.completed → core.closed`
- **AND** its documentation and review `blocked`, `failed`, and `comments` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Research definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** it exposes the `research` definition with `core.research` as initial and `core.closed` as terminal
- **AND** `core.research` SHALL route to the `researcher` role and require persistent interactive session capabilities
- **AND** the developer-only research actions and reachable lifecycle SHALL remain unchanged

#### Scenario: Workflow graph is invalid
- **WHEN** a definition contains a missing step, dangling outcome, unreachable terminal, undeclared cycle, unbounded retry, unknown actor, or unavailable effect
- **THEN** registration SHALL fail before any workflow can use that definition
- **AND** a partial definition SHALL NOT remain registered

### Requirement: Plugin-grade built-in registry seam

Built-in steps and workflows SHALL register through the same public definition contract reserved for future trusted workflow plugins, while this release SHALL NOT automatically discover or execute external workflow plugin code.

#### Scenario: Built-in workflows initialize
- **WHEN** the engine starts
- **THEN** `openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`, `openspec-fusion-propose`, `no-openspec`, `wiki`, and `research` definitions SHALL be registered through the public registry contract
- **AND** the UI-only `wiki-comments` definition SHALL also be registered for its internal start path
- **AND** the removed `openspec-full`, old `openspec-apply`, `openspec-fusion-full`, old `openspec-fusion-propose`, `openspec-jev`, and `openspec-jev-apply` definitions SHALL NOT be registered
- **AND** the engine SHALL validate them identically to later registered definitions

#### Scenario: External package is present
- **WHEN** an unconfigured package or file exports workflow definitions
- **THEN** the engine SHALL NOT load or execute it automatically
- **AND** no filesystem discovery order SHALL affect registered workflows

## ADDED Requirements

### Requirement: Removed workflow definition diagnostic

A start against a workflow definition that is not registered, including an
identifier removed by this change, SHALL fail with an actionable
`unknown/removed definition` diagnostic that names the requested identifier and
lists the registered alternatives. The workflow store status and drain path
SHALL surface the same diagnostic for a persisted run whose pinned definition
can no longer be resolved, instead of a generic pin or registry error.

#### Scenario: Removed identifier is started
- **WHEN** a caller starts a workflow with a removed identifier such as `openspec-full` or `openspec-jev`
- **THEN** startup SHALL fail before creating any workflow state or launching an agent
- **AND** the diagnostic SHALL identify the requested identifier as removed or unknown

#### Scenario: Persisted run references a removed definition
- **WHEN** the status or drain path encounters a persisted run whose pinned definition id is no longer registered
- **THEN** it SHALL report an `unknown/removed definition` diagnostic naming the definition and the run
- **AND** it SHALL NOT report a generic pin mismatch

#### Scenario: Registered alternative is suggested
- **WHEN** a removed OpenSpec identifier maps to a registered replacement
- **THEN** the diagnostic SHALL name the registered definition a caller should use instead
