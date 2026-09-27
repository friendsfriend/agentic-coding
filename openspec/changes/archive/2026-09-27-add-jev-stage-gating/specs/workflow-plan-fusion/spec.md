# Spec Delta

## MODIFIED Requirements

### Requirement: Plan-fusion workflow composition

The system SHALL register a built-in workflow definition `openspec-fusion` whose graph prepends the classification pass, a fusion-planning fan-out step, and a plan-fusion consolidation step ahead of the standard flow's plan-approval step, reusing the standard flow's steps unchanged from plan approval onward. In the definition version tier that carries the stage gates, its successful path SHALL be `core.route-plan → fusion.plan → fusion.consolidate → core.plan-gate → core.plan-approval → core.route-apply → core.implementation → core.triage-route → core.triage → core.verification → core.review-gate → core.developer-review → core.wiki-gate → core.wiki → core.wiki-approval → core.archive → core.delivery → core.completed → core.closed`, and definition version tiers registered before that tier SHALL keep their previously registered graph. The system SHALL also register `openspec-fusion-propose`, which starts at `core.route-plan`, uses the same classification, fusion-planning, and consolidation steps, routes a successful consolidation to the plan gate, and omits implementation, verification, archive, and delivery steps.

#### Scenario: Plan-fusion workflow starts
- **WHEN** a workflow is started with the `openspec-fusion` definition
- **THEN** the initial step SHALL be the classification pass
- **AND** the graph SHALL route classification to the fusion-planning step, consolidation to the plan gate, and onward through the standard flow

#### Scenario: Plan-fusion enters plan approval through the gate
- **WHEN** the plan gate in an `openspec-fusion` run reports a run
- **THEN** the workflow SHALL enter `core.plan-approval`
- **AND** a plan gate skip SHALL enter the apply-phase routing step that plan approval would have entered

#### Scenario: Fusion proposal workflow starts
- **WHEN** a workflow is started with the `openspec-fusion-propose` definition
- **THEN** the initial step SHALL be the classification pass
- **AND** the graph SHALL route consolidation to the plan gate, a run outcome to `core.plan-approval`, then `core.completed`, then `core.closed`
- **AND** the graph SHALL contain no implementation, verification, archive, delivery, or pull-request step

#### Scenario: Existing workflows are unaffected
- **WHEN** `openspec-fusion` and `openspec-fusion-propose` are registered
- **THEN** the other registered built-in definitions SHALL keep their identifiers, versions, graphs, and pins

### Requirement: Consolidation into one OpenSpec proposal

The plan-fusion consolidation step SHALL be an agent step whose declared inputs are all validated planner drafts from the fan-out; it SHALL produce one consolidated OpenSpec proposal by creating the normal OpenSpec change artifacts, and its instructions SHALL direct it to reconcile conflicting approaches and record rejected alternatives rather than concatenate drafts. For `openspec-fusion`, consolidation completion SHALL enter the plan gate and a plan gate run SHALL enter OpenSpec full plan approval; for `openspec-fusion-propose`, consolidation completion SHALL enter the plan gate, a plan gate run SHALL enter plan approval, and a successful approval or a plan gate skip SHALL route to completion without execution.

#### Scenario: Consolidation consumes all drafts
- **WHEN** the consolidation step activates
- **THEN** its rendered assignment SHALL identify every validated planner draft as scoped input
- **AND** the agent SHALL NOT receive any subset silently dropped by the engine

#### Scenario: Consolidated plan-fusion proposal enters standard review
- **WHEN** the consolidation agent in an `openspec-fusion` workflow hands off `complete` and the plan gate reports a run
- **THEN** the workflow SHALL present the consolidated proposal to the developer through the standard plan-approval step
- **AND** approval comments MAY return the workflow to either fusion step per the pinned graph without bypassing review

#### Scenario: Consolidated fusion proposal terminates
- **WHEN** the consolidation agent in an `openspec-fusion-propose` workflow hands off `complete`
- **THEN** the workflow SHALL enter the plan gate and a run outcome SHALL enter plan approval, whose successful approval SHALL enter `core.completed`
- **AND** no implementation, verification, archive, delivery, or pull-request effect SHALL be requested
