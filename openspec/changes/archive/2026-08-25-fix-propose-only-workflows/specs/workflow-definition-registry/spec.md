## MODIFIED Requirements

### Requirement: Explicit workflow composition
The system SHALL define each workflow as an explicit, versioned graph of registered steps and legal outcomes rather than deriving behavior from phase names or array position. The catalog SHALL include explicit `standard-propose` and `fusion-propose` graphs that reference the registered planning, plan-approval, completion, and terminal steps needed for proposal-only execution, while excluding implementation, verification, archive, delivery, and pull-request action/effect paths from their reachable lifecycle.

#### Scenario: Workflow definition is valid
- **WHEN** a workflow definition is registered
- **THEN** the system SHALL verify its initial and terminal steps, referenced step identifiers, legal outcome targets, reachable terminal path, declared loops, retry bounds, actor requirements, and requested effects
- **AND** the system SHALL make the definition available only after all checks pass

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

#### Scenario: Workflow graph is invalid
- **WHEN** a definition contains a missing step, dangling outcome, unreachable terminal, undeclared cycle, unbounded retry, unknown actor, or unavailable effect
- **THEN** registration SHALL fail before any workflow can use that definition
- **AND** a partial definition SHALL NOT remain registered
