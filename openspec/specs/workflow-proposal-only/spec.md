# workflow-proposal-only Specification

## Purpose
TBD - created by archiving change implement-propose-only-worflows. Update Purpose after archive.
## Requirements
### Requirement: Proposal-only workflow graphs
The system SHALL register `standard-propose` and `fusion-propose` as explicit versioned workflow definitions. `standard-propose` SHALL start at `core.plan` and route a completed plan directly to `core.closed`; `fusion-propose` SHALL start at `fusion.plan`, route completed consolidation directly to `core.closed`, and retain the fusion planner/consolidator retry bounds and declared loops.

#### Scenario: Standard proposal completes
- **WHEN** the `core.plan` agent in a `standard-propose` run submits a validated `complete` handoff
- **THEN** the workflow SHALL enter `core.closed`
- **AND** it SHALL not enter plan approval, implementation, verification, archive, delivery, or pull-request steps

#### Scenario: Fusion proposal completes
- **WHEN** all fusion planners and the `fusion.consolidate` agent in a `fusion-propose` run submit validated complete handoffs
- **THEN** the workflow SHALL enter `core.closed`
- **AND** the workflow SHALL not enter plan approval, implementation, verification, archive, delivery, or pull-request steps

#### Scenario: Proposal planning retries
- **WHEN** a proposal planner or consolidator submits a blocked or failed outcome within its retry bound
- **THEN** the workflow SHALL follow its pinned planning retry edge
- **AND** a retry SHALL not create any downstream code-changing or delivery effect

### Requirement: Same-checkout proposal startup
The system SHALL require proposal-only workflows to start in checkout mode and SHALL use the repository itself and the currently checked-out non-detached branch as their worktree identity. Proposal workspace setup SHALL never create or switch a Git branch and SHALL never create a Git worktree.

#### Scenario: Proposal starts in checkout mode
- **WHEN** a caller starts `standard-propose` or `fusion-propose` with `--mode checkout` on a named current branch
- **THEN** the engine SHALL create or recover only the Herdr workspace and use the repository as the worktree
- **AND** it SHALL record the current branch without switching it

#### Scenario: Worktree mode is rejected
- **WHEN** a caller starts a proposal-only definition with worktree mode
- **THEN** startup SHALL fail before workspace or agent effects are launched

#### Scenario: Detached checkout is rejected
- **WHEN** a proposal-only workflow is started without a named current branch
- **THEN** startup SHALL fail with a start-guard diagnostic
- **AND** no Git or workspace mutation SHALL occur

### Requirement: Concurrent proposal isolation
The system SHALL allow a proposal-only workflow to start in a checkout already used by another workflow, including when the tree is dirty, while preserving canonical change-ID uniqueness and isolating each run's OpenSpec artifacts under its own change ID. The dirty-tree exception SHALL apply only to proposal-only definitions.

#### Scenario: Proposal coexists with full checkout workflow
- **WHEN** a full workflow and a proposal-only workflow use the same repository checkout concurrently
- **THEN** the proposal start SHALL not reject the checkout solely because it is occupied or dirty
- **AND** the proposal SHALL not switch the branch or create/remove a worktree used by the full workflow

#### Scenario: Duplicate change ID is used
- **WHEN** a proposal-only start uses a change ID already owned by a workflow
- **THEN** the canonical workflow store SHALL reject the start before launching agents
- **AND** the existing workflow SHALL remain unchanged

#### Scenario: Full workflow guard remains strict
- **WHEN** a standard, direct-apply, no-openspec, or plan-fusion workflow is started on a dirty checkout
- **THEN** the existing clean-tree start rejection SHALL remain in force

### Requirement: Normal validated proposal artifacts
The planning steps of proposal-only workflows SHALL use the existing planning instructions, structured output contracts, and OpenSpec validation effects. Standard proposal planning and fusion consolidation SHALL create the normal OpenSpec change artifacts required by the planning protocol.

#### Scenario: Standard plan is validated
- **WHEN** a `standard-propose` planner completes with a valid plan and its OpenSpec artifacts validate
- **THEN** the artifacts SHALL remain under the proposal's unique change directory
- **AND** the workflow SHALL close without approving or applying them

#### Scenario: Fusion consolidation reconciles drafts
- **WHEN** a `fusion-propose` consolidator receives all validated planner drafts
- **THEN** it SHALL create one normal consolidated OpenSpec artifact set
- **AND** it SHALL record reconciled choices, rejected alternatives, applicable risks, and unresolved questions in the artifacts

### Requirement: Proposal workflow surfaces
The CLI and dashboard SHALL expose both proposal-only definition IDs, preserve task input for standard and fusion planning, and route fusion proposals through the same planner preset/count/profile validation as plan-fusion. The dashboard SHALL select checkout behavior without offering worktree mode for proposal-only definitions.

#### Scenario: CLI starts a standard proposal
- **WHEN** the CLI receives `--workflow standard-propose --mode checkout`
- **THEN** it SHALL resolve the `standard-propose` definition and pass the task and current-branch proposal metadata to the engine

#### Scenario: Dashboard starts a fusion proposal
- **WHEN** a user selects Fusion Proposal, enters a task, and chooses a valid planner preset
- **THEN** the dashboard SHALL submit `fusion-propose` with the task and checkout semantics
- **AND** startup SHALL derive the configured distinct planner routes and consolidator route before launching agents

#### Scenario: Invalid fusion proposal preset is rejected
- **WHEN** a fusion proposal preset has fewer than 2, more than 5, non-contiguous, duplicate, or unresolved planner routes
- **THEN** startup SHALL report a routing error
- **AND** it SHALL launch no workspace or agent effects

