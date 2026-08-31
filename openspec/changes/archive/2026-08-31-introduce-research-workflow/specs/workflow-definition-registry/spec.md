## MODIFIED Requirements

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
