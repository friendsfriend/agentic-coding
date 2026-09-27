# Spec Delta

## MODIFIED Requirements

### Requirement: Proposal-only workflow graphs

The system SHALL register `openspec-propose` and `openspec-fusion-propose` as explicit versioned workflow definitions. `openspec-propose` SHALL start at `core.route-plan`, route classification to `core.plan`, route a completed plan to the plan gate, route that gate's run outcome to `core.plan-approval`, route its skip outcome to `core.completed`, and route an explicit close from `core.completed` to `core.closed`. `openspec-fusion-propose` SHALL start at `core.route-plan`, route classification to `fusion.plan`, route completed consolidation to the plan gate, route a run outcome to `core.plan-approval`, route approval and a gate skip to `core.completed`, and route an explicit close to `core.closed`. Both definitions SHALL retain their planning retry bounds and SHALL expose no reachable implementation, verification, archive, delivery, or pull-request action/effect path.

#### Scenario: Classification precedes proposal planning
- **WHEN** an `openspec-propose` or `openspec-fusion-propose` run starts
- **THEN** the initial step SHALL be `core.route-plan`
- **AND** planning SHALL begin only after the classification effect completes

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

#### Scenario: A skipped plan gate reaches completion
- **WHEN** the plan gate in an `openspec-propose` run reports a skip
- **THEN** the workflow SHALL enter `core.completed` without offering the plan approval actions
- **AND** the workflow SHALL expose an explicit close action

#### Scenario: Fusion proposal reaches the plan gate
- **WHEN** all fusion planners and the `fusion.consolidate` agent in an `openspec-fusion-propose` run submit validated complete handoffs
- **THEN** the workflow SHALL enter the plan gate
- **AND** the workflow SHALL remain active while the gate is decided

#### Scenario: Fusion proposal reaches plan approval
- **WHEN** the plan gate in an `openspec-fusion-propose` run reports a run
- **THEN** the workflow SHALL enter `core.plan-approval`
- **AND** the workflow SHALL remain active with plan-approval actions available
- **AND** it SHALL not enter `core.closed` or enqueue workspace close at this point

#### Scenario: Fusion proposal approval reaches completion
- **WHEN** a developer approves the consolidated plan in `core.plan-approval` for an `openspec-fusion-propose` run
- **THEN** the workflow SHALL enter `core.completed`
- **AND** the workflow SHALL expose an explicit close action
- **AND** it SHALL not create implementation, verification, archive, delivery, or pull-request effects

#### Scenario: A skipped fusion plan gate reaches completion
- **WHEN** the plan gate in an `openspec-fusion-propose` run reports a skip
- **THEN** the workflow SHALL enter `core.completed` without offering the plan approval actions
- **AND** it SHALL not create implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Proposal is explicitly closed
- **WHEN** a developer dispatches the close action from `core.completed` for either proposal definition
- **THEN** the workflow SHALL enter `core.closed`
- **AND** workspace close and cleanup effects SHALL be scheduled only after this transition

#### Scenario: Proposal planning retries
- **WHEN** a proposal planner or consolidator submits a blocked or failed outcome within its retry bound
- **THEN** the workflow SHALL follow its pinned planning retry edge
- **AND** a retry SHALL not create any downstream code-changing or delivery effect

#### Scenario: Proposal plan is rejected
- **WHEN** a developer rejects a plan at `core.plan-approval`
- **THEN** `openspec-propose` SHALL return to `core.plan` and `openspec-fusion-propose` SHALL return to the fusion consolidation path
- **AND** the workflow SHALL remain in planning without closing the workspace

#### Scenario: Proposal plan receives comments
- **WHEN** a developer submits bounded review comments at `core.plan-approval`
- **THEN** `openspec-propose` SHALL return to `core.plan` and `openspec-fusion-propose` SHALL return to the fusion consolidation path
- **AND** the returned planning step SHALL receive the comments as review-fix context
- **AND** the workspace SHALL remain open
