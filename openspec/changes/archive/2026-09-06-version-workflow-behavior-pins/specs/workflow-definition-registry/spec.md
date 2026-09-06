## MODIFIED Requirements

### Requirement: Registered step contract
The system SHALL represent every workflow step as a registered, versioned definition with a stable identifier, actor kind, input and output contract, permitted outcomes, entry and completion validation, instruction assets when applicable, allowlisted external effects, and a declarative step behavior block carrying the step's engine-internal semantics. The behavior block SHALL cover agent role selection, entry guards, arrival semantics, entry effects, developer actions, and assignment inputs. New definition versions SHALL bind executable semantics through explicit behavior compatibility versions rather than function-source hashes. Supported historical digest formats SHALL remain unchanged through an explicit legacy compatibility mapping; moving equivalent behavior SHALL not by itself invalidate a pin.

#### Scenario: Built-in step is registered
- **WHEN** the engine initializes its built-in step catalog
- **THEN** every step SHALL expose all required contract fields
- **AND** no command handler SHALL provide an unregistered lifecycle path around the step contract

#### Scenario: Step output is incompatible
- **WHEN** a run submits output that does not satisfy its pinned step output contract
- **THEN** the engine SHALL reject completion without changing workflow state
- **AND** rejection SHALL identify the failed contract

#### Scenario: Equivalent behavior is relocated
- **WHEN** registered behavior is refactored without changing its declared compatible semantics
- **THEN** historical definition and step digests SHALL remain unchanged
- **AND** supported existing workflows SHALL continue dispatching without repair or migration

#### Scenario: Behavior changes incompatibly
- **WHEN** a step's guards, outcomes, aggregation, role selection, context transfer, or effect behavior changes incompatibly
- **THEN** the changed implementation SHALL have a distinct semantic compatibility identity
- **AND** it SHALL not silently replace the implementation resolved by an existing pin

#### Scenario: Behavior declares no agent roles for an agent step
- **WHEN** a step whose actor kind is `agent` is registered with a behavior block that resolves to no roles
- **THEN** registration SHALL be rejected identifying the offending step
- **AND** no partially registered catalog SHALL be exposed

### Requirement: Definition pinning
Each workflow SHALL pin its exact workflow-definition identifier, version, and digest for its lifetime unless a validated migration changes that pin. New-definition pins SHALL also determine exact executable step and behavior compatibility versions. Supported legacy pins SHALL resolve through explicit compatibility mappings, never an implicit current-version fallback.

#### Scenario: Workflow starts
- **WHEN** a start command accepts a workflow definition
- **THEN** the persisted workflow SHALL record its exact definition identity and enough semantic identity to resolve the accepted step implementations
- **AND** all later commands and effects SHALL evaluate against those implementations

#### Scenario: Registry definition changes
- **WHEN** a registered definition digest or required semantic compatibility identity no longer matches an active workflow pin
- **THEN** the workflow SHALL be blocked before further mutation or effect execution
- **AND** the engine SHALL require matching implementation restoration or validated migration rather than reinterpret state

#### Scenario: Supported legacy workflow is loaded
- **WHEN** an existing step-ID-only definition has a declared supported baseline mapping
- **THEN** the engine SHALL resolve that baseline without rewriting its historical digest
- **AND** missing or incompatible mappings SHALL fail closed with a compatibility diagnostic

#### Scenario: Semantic migration is accepted
- **WHEN** an operator confirms a compatible migration with current revision, reason, and a preview of affected runs/effects
- **THEN** the engine SHALL validate the target state, expire incompatible ownership, and atomically record old/new pins and the migration event
- **AND** an ordinary digest-only repin SHALL not bypass these checks

#### Scenario: Semantic migration fails
- **WHEN** target compatibility, evidence, revision, or persistence validation fails
- **THEN** the prior pins, run ownership, state, and pending effects SHALL remain unchanged

## ADDED Requirements

### Requirement: Exact step-version resolution
New workflow definitions SHALL reference exact registered step versions, and all workflow-dependent registry lookups SHALL use those references. Multiple versions of the same stable step ID SHALL coexist without changing existing definitions.

#### Scenario: Two step versions coexist
- **WHEN** old and new workflows reference different versions of one stable step ID
- **THEN** each SHALL use its own version for guards, role routing, completion, assignment contracts, effect legality, and view metadata
- **AND** neither SHALL fall back to step version 1 or the most recently registered version

#### Scenario: Exact referenced version is unavailable
- **WHEN** a manifest references an unavailable step or behavior compatibility version
- **THEN** registration or workflow loading SHALL fail with the missing identity before execution

#### Scenario: Presentation-only instructions change
- **WHEN** only instruction presentation or labels change without changing semantic contracts
- **THEN** semantic pins SHALL not change solely because of function formatting or instruction text
- **AND** rendered assignments SHALL continue recording their instruction asset digests
