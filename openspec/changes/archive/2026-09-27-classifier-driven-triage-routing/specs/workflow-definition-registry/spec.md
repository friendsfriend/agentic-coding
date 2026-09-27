# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit extension selection
A registered step or workflow extension SHALL affect only definitions that explicitly reference it. A change to a built-in graph's shape SHALL be published as a new definition version tier that references the new step, and the earlier tiers' graphs, digests, and step lists SHALL remain registered unchanged.

#### Scenario: Additional step is registered
- **WHEN** a new step becomes available in registry
- **THEN** existing workflow definitions SHALL remain unchanged
- **AND** step SHALL run only in a definition that explicitly includes its stable identifier

#### Scenario: Multiple extensions target same workflow area
- **WHEN** developer composes multiple registered steps around same built-in step
- **THEN** explicit workflow graph order SHALL determine execution
- **AND** engine SHALL NOT infer plugin insertion order from discovery order

#### Scenario: Built-in graph gains a step
- **WHEN** a built-in definition family's shared loop gains a step
- **THEN** definitions pinned to earlier version tiers SHALL keep their previous graph, digest, and resolvable steps
- **AND** newly started workflows SHALL resolve a definition version whose graph includes the new step

### Requirement: Definition pinning
Each workflow SHALL pin its exact workflow-definition identifier, version, and digest for its lifetime unless a validated migration changes that pin. New-definition pins SHALL also determine exact executable step and behavior compatibility versions. Supported legacy pins SHALL resolve through explicit compatibility mappings, never an implicit current-version fallback. A new definition version tier SHALL be the default resolved version for new starts, and an already pinned workflow SHALL NOT be re-pinned to it implicitly.

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

#### Scenario: New version tier becomes the start default
- **WHEN** a newer definition version tier is registered for a workflow family
- **THEN** new starts SHALL resolve that tier's definition
- **AND** a workflow already pinned to an earlier tier SHALL keep resolving its
  own registered version without operator action

## ADDED Requirements

### Requirement: New shared step is resolvable by legacy pins

A step introduced by a newer definition version tier SHALL be added to the
registry's explicit legacy step compatibility mapping when any registered
definition without exact step references contains it, so that definition tier
resolves the step instead of failing closed with an unsupported mapping error.
The mapping SHALL resolve the step at the declared step version and SHALL NOT
infer a compatibility identity for any other step.

#### Scenario: Legacy tier contains the new step

- **WHEN** a definition pinned to a version tier without exact step references
  contains a step introduced by a newer tier
- **THEN** the engine SHALL resolve that step through the declared legacy
  mapping
- **AND** it SHALL NOT fail with an unsupported legacy step compatibility error

#### Scenario: Unmapped legacy step still fails closed

- **WHEN** a definition without exact step references contains a step absent
  from the legacy mapping
- **THEN** the engine SHALL fail closed with a compatibility diagnostic
