# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit workflow composition

The system SHALL define each workflow as an explicit, versioned graph of registered steps and legal outcomes rather than deriving behavior from phase names or array position. The catalog SHALL include explicit `openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`, `openspec-fusion-propose`, `wiki`, and `research` graphs that reference the registered steps needed for their respective execution, including the classifier routing pass each OpenSpec family needs, while excluding implementation, verification, archive, delivery, and pull-request action/effect paths from proposal-only, wiki, and research lifecycles. A definition that owns a gated stage SHALL also contain that stage's gate step, the routing step that already precedes triage in the implementation loop SHALL additionally decide the verification gate, and a definition with no gated stage SHALL contain no gate step.

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
- **THEN** `openspec-propose` SHALL contain `core.route-plan`, `core.plan`, the plan gate, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.route-plan → core.plan → core.plan-gate → core.plan-approval → core.completed → core.closed`
- **AND** its planning `blocked` and `failed` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Fusion proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec-fusion-propose` SHALL contain `core.route-plan`, `fusion.plan`, `fusion.consolidate`, the plan gate, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.route-plan → fusion.plan → fusion.consolidate → core.plan-gate → core.plan-approval → core.completed → core.closed`
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

#### Scenario: Definitions with a gated stage contain its gate
- **WHEN** the built-in catalog is initialized
- **THEN** a definition containing a plan approval step SHALL also contain the plan gate, with a run outcome into plan approval and a skip outcome into plan approval's own approval target
- **AND** a definition containing a developer review step SHALL enter the review gate after a passing verification round, and route that gate's skip to the wiki gate when a wiki gate exists
- **AND** a definition containing a wiki gate SHALL route a developer approval and a review-gate skip into that wiki gate, and the wiki gate's skip into the archive step or, without an archive step, into delivery
- **AND** a definition with no plan approval, developer review, or wiki stage SHALL contain no corresponding gate step, and the standalone wiki and research lifecycles SHALL keep their graphs unchanged

#### Scenario: The archive step is never behind a gate
- **WHEN** the built-in catalog is initialized
- **THEN** no gate step SHALL be registered between the last gated stage and an archive step of a definition that has one
- **AND** every outcome of every gate step SHALL have an explicit registered target

#### Scenario: Workflow graph is invalid
- **WHEN** a definition contains a missing step, dangling outcome, unreachable terminal, undeclared cycle, unbounded retry, unknown actor, or unavailable effect
- **THEN** registration SHALL fail before any workflow can use that definition
- **AND** a partial definition SHALL NOT remain registered

## ADDED Requirements

### Requirement: A built-in graph shape change is published as a new definition version tier

A change that adds a step to, or an edge between, the built-in graphs SHALL be
registered as a new definition version tier rather than by mutating an existing
tier, so a workflow already pinned to an earlier tier keeps its graph, its
digest, and its resolvable steps. Every new gate step SHALL be added to the
registry's explicit legacy step compatibility mapping so a definition tier
without exact step references that contains it resolves instead of failing
closed, and a new start SHALL resolve the newest tier. The earlier tiers SHALL
remain registered and SHALL keep their previously registered graphs.

#### Scenario: New tier carries the gate steps

- **WHEN** the gate-tier definition version is registered
- **THEN** each definition that owns a gated stage SHALL contain that stage's gate
  step and the corresponding edges
- **AND** a new start of a non-research family SHALL resolve this tier

#### Scenario: Earlier tiers keep their graph

- **WHEN** a workflow is pinned to a definition version tier registered before the
  gate tier
- **THEN** that workflow SHALL keep its previous graph, step list, and digest
- **AND** it SHALL dispatch without repair

#### Scenario: Legacy tiers resolve the new gate steps

- **WHEN** a definition without exact step references contains a gate step
- **THEN** the engine SHALL resolve that step through the declared legacy step
  compatibility mapping
