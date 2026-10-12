## MODIFIED Requirements

### Requirement: Plan-fusion workflow composition

The system SHALL register a built-in workflow definition `openspec-fusion` whose graph prepends a fusion-planning fan-out step and a plan-fusion consolidation step ahead of the standard flow's plan-approval step, reusing the standard flow's steps unchanged from plan approval onward. In the definition version tier that carries the stage gates, its successful path SHALL be `fusion.plan → fusion.consolidate → core.plan-gate → core.plan-approval → core.implementation → core.triage-route → core.triage → core.verification → core.review-gate → core.developer-review → core.wiki-gate → core.wiki → core.wiki-approval → core.archive → core.delivery → core.completed → core.closed`, and definition version tiers registered before that tier SHALL keep their previously registered graph. The system SHALL also register `openspec-fusion-propose`, which starts at `fusion.plan`, uses the same fusion-planning and consolidation steps, routes a successful consolidation to the plan gate, and omits implementation, verification, archive, and delivery steps.

#### Scenario: Plan-fusion workflow starts
- **WHEN** a workflow is started with the `openspec-fusion` definition
- **THEN** the initial step SHALL be `fusion.plan`
- **AND** the graph SHALL route consolidation to the plan gate, and onward through the standard flow
- **AND** no model-routing step SHALL appear in the graph

#### Scenario: Plan-fusion enters plan approval through the gate
- **WHEN** the plan gate in an `openspec-fusion` run reports a run
- **THEN** the workflow SHALL enter `core.plan-approval`
- **AND** a plan gate skip SHALL enter `core.implementation`, the step plan approval would have entered

#### Scenario: Fusion proposal workflow starts
- **WHEN** a workflow is started with the `openspec-fusion-propose` definition
- **THEN** the initial step SHALL be `fusion.plan`
- **AND** the graph SHALL route consolidation to the plan gate, a run outcome to `core.plan-approval`, then `core.completed`, then `core.closed`
- **AND** the graph SHALL contain no implementation, verification, archive, delivery, or pull-request step

#### Scenario: Existing workflows are unaffected
- **WHEN** `openspec-fusion` and `openspec-fusion-propose` are registered
- **THEN** the other registered built-in definitions SHALL keep their identifiers, versions, graphs, and pins
