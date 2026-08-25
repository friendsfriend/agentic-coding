## MODIFIED Requirements

### Requirement: Explicit workflow composition
The system SHALL define each workflow as an explicit, versioned graph of registered steps and legal outcomes rather than deriving behavior from phase names or array position. The catalog SHALL include explicit `standard-propose` and `fusion-propose` graphs that reference only registered planning and terminal steps needed for proposal-only execution.

#### Scenario: Workflow definition is valid
- **WHEN** a workflow definition is registered
- **THEN** the system SHALL verify its initial and terminal steps, referenced step identifiers, legal outcome targets, reachable terminal path, declared loops, retry bounds, actor requirements, and requested effects
- **AND** the system SHALL make the definition available only after all checks pass

#### Scenario: Proposal definitions are planning-only
- **WHEN** the built-in catalog is initialized
- **THEN** `standard-propose` SHALL contain the core planning path followed by `core.closed`
- **AND** `fusion-propose` SHALL contain the fusion planning/consolidation path followed by `core.closed`
- **AND** neither proposal definition SHALL reference approval, implementation, verification, archive, delivery, or pull-request steps

#### Scenario: Workflow graph is invalid
- **WHEN** a definition contains a missing step, dangling outcome, unreachable terminal, undeclared cycle, unbounded retry, unknown actor, or unavailable effect
- **THEN** registration SHALL fail before any workflow can use that definition
- **AND** a partial definition SHALL NOT remain registered

### Requirement: Plugin-grade built-in registry seam
Built-in steps and workflows SHALL register through the same public definition contract reserved for future trusted workflow plugins, while this release SHALL NOT automatically discover or execute external workflow plugin code.

#### Scenario: Built-in workflows initialize
- **WHEN** the engine starts
- **THEN** standard, direct-apply, no-OpenSpec, plan-fusion, standard-propose, and fusion-propose definitions SHALL be registered through the public registry contract
- **AND** the engine SHALL validate them identically to later registered definitions

#### Scenario: External package is present
- **WHEN** an unconfigured package or file exports workflow definitions
- **THEN** the engine SHALL NOT load or execute it automatically
- **AND** no filesystem discovery order SHALL affect registered workflows
