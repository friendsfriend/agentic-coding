## MODIFIED Requirements

### Requirement: Proposal-only workflow graphs

The system SHALL register `openspec-propose` and `openspec-fusion-propose` as explicit versioned workflow definitions. `openspec-propose` SHALL start at `core.plan`, route a completed plan to the plan gate, route that gate's run outcome to `core.plan-approval`, route its skip outcome to `core.completed`, and route an explicit close from `core.completed` to `core.closed`. `openspec-fusion-propose` SHALL start at `fusion.plan`, route completed consolidation to the plan gate, route a run outcome to `core.plan-approval`, route approval and a gate skip to `core.completed`, and route an explicit close to `core.closed`. Both definitions SHALL retain their planning retry bounds, SHALL carry no routing step, and SHALL expose no reachable implementation, verification, archive, delivery, or pull-request action/effect path.

#### Scenario: Proposal planning is the first step
- **WHEN** an `openspec-propose` or `openspec-fusion-propose` run starts
- **THEN** the initial step SHALL be `core.plan` or `fusion.plan` respectively
- **AND** no model-routing step SHALL precede it

#### Scenario: Standard proposal reaches the plan gate
- **WHEN** the `core.plan` agent in an `openspec-propose` run submits a validated `complete` handoff
- **THEN** the workflow SHALL enter the plan gate
- **AND** the workflow SHALL remain active while the gate is decided

#### Scenario: Standard proposal reaches plan approval
- **WHEN** the plan gate in an `openspec-propose` run reports a run
- **THEN** the workflow SHALL enter `core.plan-approval`
- **AND** the workflow SHALL remain active with plan-approval actions available
- **AND** it SHALL not enter `core.closed` or enqueue workspace close at this point

#### Scenario: Standard proposal approval reaches completion
- **WHEN** a developer approves the plan in `core.plan-approval` for an `openspec-propose` run
- **THEN** the workflow SHALL enter `core.completed`
- **AND** the workflow SHALL expose an explicit close action
- **AND** it SHALL not create implementation, verification, archive, delivery, or pull-request effects
