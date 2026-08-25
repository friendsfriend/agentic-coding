## MODIFIED Requirements

### Requirement: Proposal-only workflow graphs
The system SHALL register `standard-propose` and `fusion-propose` as explicit versioned workflow definitions. `standard-propose` SHALL start at `core.plan`, route a completed plan to `core.plan-approval`, route approval to `core.completed`, and route an explicit close from `core.completed` to `core.closed`. `fusion-propose` SHALL start at `fusion.plan`, route completed consolidation to `core.plan-approval`, route approval to `core.completed`, and route an explicit close to `core.closed`. Both definitions SHALL retain their planning retry bounds and SHALL expose no reachable implementation, verification, archive, delivery, or pull-request action/effect path.

#### Scenario: Standard proposal reaches plan approval
- **WHEN** the `core.plan` agent in a `standard-propose` run submits a validated `complete` handoff
- **THEN** the workflow SHALL enter `core.plan-approval`
- **AND** the workflow SHALL remain active with plan-approval actions available
- **AND** it SHALL not enter `core.closed` or enqueue workspace close at this point

#### Scenario: Standard proposal approval reaches completion
- **WHEN** a developer approves the plan in `core.plan-approval` for a `standard-propose` run
- **THEN** the workflow SHALL enter `core.completed`
- **AND** the workflow SHALL expose an explicit close action
- **AND** it SHALL not create implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Fusion proposal reaches plan approval
- **WHEN** all fusion planners and the `fusion.consolidate` agent in a `fusion-propose` run submit validated complete handoffs
- **THEN** the workflow SHALL enter `core.plan-approval`
- **AND** the workflow SHALL remain active with plan-approval actions available
- **AND** it SHALL not enter `core.closed` or enqueue workspace close at this point

#### Scenario: Fusion proposal approval reaches completion
- **WHEN** a developer approves the consolidated plan in `core.plan-approval` for a `fusion-propose` run
- **THEN** the workflow SHALL enter `core.completed`
- **AND** the workflow SHALL expose an explicit close action
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
- **THEN** `standard-propose` SHALL return to `core.plan` and `fusion-propose` SHALL return to `fusion.consolidate`
- **AND** the workflow SHALL remain in planning without closing the workspace

#### Scenario: Proposal plan receives comments
- **WHEN** a developer submits bounded review comments at `core.plan-approval`
- **THEN** `standard-propose` SHALL return to `core.plan` and `fusion-propose` SHALL return to `fusion.consolidate`
- **AND** the returned planning step SHALL receive the comments as review-fix context
- **AND** the workspace SHALL remain open

### Requirement: Normal validated proposal artifacts
The planning steps of proposal-only workflows SHALL use the existing planning instructions, structured output contracts, and OpenSpec validation effects. Standard proposal planning and fusion consolidation SHALL create the normal OpenSpec change artifacts required by the planning protocol, and those artifacts SHALL remain available while the workflow awaits approval and while it is in `core.completed`.

#### Scenario: Standard plan is validated
- **WHEN** a `standard-propose` planner completes with a valid plan and its OpenSpec artifacts validate
- **THEN** the artifacts SHALL remain under the proposal's unique change directory
- **AND** the workflow SHALL enter plan approval rather than closing or applying the artifacts

#### Scenario: Fusion consolidation reconciles drafts
- **WHEN** a `fusion-propose` consolidator receives all validated planner drafts
- **THEN** it SHALL create one normal consolidated OpenSpec artifact set
- **AND** it SHALL record reconciled choices, rejected alternatives, applicable risks, and unresolved questions in the artifacts
- **AND** the workflow SHALL enter plan approval rather than closing or applying the artifacts

### Requirement: Proposal workflow surfaces
The CLI and dashboard SHALL expose both proposal-only definition IDs, preserve task input for standard and fusion planning, and route fusion proposals through the same planner preset/count/profile validation as plan-fusion. The dashboard SHALL select checkout behavior without offering worktree mode for proposal-only definitions, SHALL show plan-approval state and actions, SHALL show proposal completion with an explicit close action, and SHALL not offer pull-request creation for proposal definitions.

#### Scenario: CLI starts a standard proposal
- **WHEN** the CLI receives `--workflow standard-propose --mode checkout`
- **THEN** it SHALL resolve the `standard-propose` definition and pass the task and current-branch proposal metadata to the engine

#### Scenario: Dashboard starts a fusion proposal
- **WHEN** a user selects Fusion Proposal, enters a task, and chooses a valid planner preset
- **THEN** the dashboard SHALL submit `fusion-propose` with the task and checkout semantics
- **AND** startup SHALL derive the configured distinct planner routes and consolidator route before launching agents

#### Scenario: Dashboard shows proposal plan approval
- **WHEN** a proposal has entered `core.plan-approval`
- **THEN** the dashboard SHALL display the plan-approval state
- **AND** it SHALL expose approve, reject, and review-comments actions

#### Scenario: Dashboard shows proposal completion
- **WHEN** a proposal has entered `core.completed`
- **THEN** the dashboard SHALL display the workflow as completed rather than closed
- **AND** it SHALL expose explicit close/cleanup actions
- **AND** it SHALL not display or submit a pull-request action

#### Scenario: Invalid fusion proposal preset is rejected
- **WHEN** a fusion proposal preset has fewer than 2, more than 5, non-contiguous, duplicate, or unresolved planner routes
- **THEN** startup SHALL report a routing error
- **AND** it SHALL launch no workspace or agent effects
