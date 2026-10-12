## ADDED Requirements

### Requirement: Per-step model selection tier

The catalog SHALL publish a definition version tier
`definitionVersionForModelSelection(rounds) = rounds + 900` that registers every
family with the same graphs as the family-traits tier minus the per-step routing
steps, and every family SHALL resolve at that tier for a new start. Definition
version tiers registered before it SHALL keep their previously registered
graphs, step lists, and digests, and the route-step definitions they reference
SHALL stay resolvable so a workflow pinned to one of them keeps dispatching.

#### Scenario: New starts resolve the newest tier without route steps

- **WHEN** a workflow is started after the tier is registered
- **THEN** its pinned definition SHALL carry no `core.route-*` step
- **AND** every family SHALL resolve at that tier

#### Scenario: An earlier pin keeps its graph

- **WHEN** a workflow pinned to a tier below the model-selection tier resumes
- **THEN** it SHALL resolve that tier's graph, steps, and digest unchanged
- **AND** its route steps SHALL remain resolvable

## MODIFIED Requirements

### Requirement: Explicit workflow composition

The system SHALL define each workflow as an explicit, versioned graph of registered steps and legal outcomes rather than deriving behavior from phase names or array position. The catalog SHALL include explicit `openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`, `openspec-fusion-propose`, `wiki`, and `research` graphs that reference the registered steps needed for their respective execution, including the agent steps each OpenSpec family runs, while excluding implementation, verification, archive, delivery, and pull-request action/effect paths from proposal-only, wiki, and research lifecycles. A definition that owns a gated stage SHALL also contain that stage's gate step, the triage-routing step that already precedes triage in the implementation loop SHALL additionally decide the verification gate, and a definition with no gated stage SHALL contain no gate step.

#### Scenario: Workflow graph is explicit
- **WHEN** a workflow definition is registered
- **THEN** the system SHALL expose its new technical ID, UI label, initial step, terminal steps, registered steps, legal outcome targets, declared loops, retry bounds, actor requirements, and requested effects as an explicit validated graph

#### Scenario: OpenSpec definitions are explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec` SHALL start at `core.plan` and continue to the standard flow once a plan exists
- **AND** `openspec-apply` SHALL start at `core.implementation` without a routing step
- **AND** `openspec-fusion` SHALL start at `fusion.plan` and continue through consolidation and the standard flow
- **AND** none of them SHALL contain a `core.route-*` step

#### Scenario: Standard proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec-propose` SHALL contain `core.plan`, the plan gate, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.plan → core.plan-gate → core.plan-approval → core.completed → core.closed`
- **AND** its planning `blocked` and `failed` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Fusion proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec-fusion-propose` SHALL contain `fusion.plan`, `fusion.consolidate`, the plan gate, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `fusion.plan → fusion.consolidate → core.plan-gate → core.plan-approval → core.completed → core.closed`
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
