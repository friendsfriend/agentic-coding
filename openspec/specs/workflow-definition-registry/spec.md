# workflow-definition-registry Specification

## Purpose
Defines rigid, versioned workflow and step contracts that remain easy to compose and can later be registered by trusted workflow plugins without changing runtime semantics.

## Requirements

### Requirement: Registered step contract
The system SHALL represent every workflow step as a registered, versioned definition with a stable identifier, actor kind, input and output contract, permitted outcomes, entry and completion validation, instruction assets when applicable, and allowlisted external effects.

#### Scenario: Built-in step is registered
- **WHEN** engine initializes its built-in step catalog
- **THEN** every step SHALL expose all required contract fields
- **AND** no command handler SHALL provide an unregistered lifecycle path around the step contract

#### Scenario: Step output is incompatible
- **WHEN** a run submits output that does not satisfy its pinned step output contract
- **THEN** engine SHALL reject completion without changing workflow state
- **AND** rejection SHALL identify the failed contract

### Requirement: Explicit workflow composition
The system SHALL define each workflow as an explicit, versioned graph of registered steps and legal outcomes rather than deriving behavior from phase names or array position.

#### Scenario: Workflow definition is valid
- **WHEN** a workflow definition is registered
- **THEN** engine SHALL verify its initial and terminal steps, referenced step identifiers, legal outcome targets, reachable terminal path, declared loops, retry bounds, actor requirements, and requested effects
- **AND** engine SHALL make definition available only after all checks pass

#### Scenario: Workflow graph is invalid
- **WHEN** a definition contains a missing step, dangling outcome, unreachable terminal, undeclared cycle, unbounded retry, unknown actor, or unavailable effect
- **THEN** registration SHALL fail before any workflow can use that definition
- **AND** partial definition SHALL NOT remain registered

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
Built-in steps and workflows SHALL register through same public definition contract reserved for future trusted workflow plugins, while this release SHALL NOT automatically discover or execute external workflow plugin code.

#### Scenario: Built-in workflows initialize
- **WHEN** engine starts
- **THEN** standard, direct-apply, and no-OpenSpec definitions SHALL be registered through public registry contract
- **AND** engine SHALL validate them identically to later registered definitions

#### Scenario: External package is present
- **WHEN** an unconfigured package or file exports workflow definitions
- **THEN** engine SHALL NOT load or execute it automatically
- **AND** no filesystem discovery order SHALL affect registered workflows
