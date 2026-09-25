# workflow-plan-fusion Specification

## Purpose
Defines the plan-fusion workflow type: parallel multi-model planning where 2–5 planner runs receive the same prompt-engineered objective, each produces a structured plan draft against a pinned output schema, and a consolidation step fuses the drafts into one OpenSpec proposal before the standard approval and execution flow.

## Requirements

### Requirement: Plan-fusion workflow composition

The system SHALL register a built-in workflow definition `openspec-fusion` whose graph prepends the classification pass, a fusion-planning fan-out step, and a plan-fusion consolidation step ahead of the standard flow's plan-approval step, reusing the standard flow's steps unchanged from plan approval onward. Its successful path SHALL be `core.route-plan → fusion.plan → fusion.consolidate → core.plan-approval → implementation → triage → verification → developer review → archive → wiki → wiki approval → delivery → completed → closed`. The system SHALL also register `openspec-fusion-propose`, which starts at `core.route-plan`, uses the same classification, fusion-planning, and consolidation steps, routes a successful consolidation to `core.plan-approval`, and omits implementation, verification, archive, and delivery steps.

#### Scenario: Plan-fusion workflow starts
- **WHEN** a workflow is started with the `openspec-fusion` definition
- **THEN** the initial step SHALL be the classification pass
- **AND** the graph SHALL route classification to the fusion-planning step, consolidation to the standard plan-approval step, and onward through the unchanged standard flow

#### Scenario: Fusion proposal workflow starts
- **WHEN** a workflow is started with the `openspec-fusion-propose` definition
- **THEN** the initial step SHALL be the classification pass
- **AND** the graph SHALL route consolidation to `core.plan-approval`, then `core.completed`, then `core.closed`
- **AND** the graph SHALL contain no implementation, verification, archive, delivery, or pull-request step

#### Scenario: Existing workflows are unaffected
- **WHEN** `openspec-fusion` and `openspec-fusion-propose` are registered
- **THEN** the other registered built-in definitions SHALL keep their identifiers, versions, graphs, and pins

### Requirement: Parallel multi-model planning fan-out

The fusion-planning step SHALL launch between 2 and 5 planner runs in parallel, one per profile of the classified roster, each receiving the same prompt-engineered objective (same instruction assets and objective text) with a distinct planner role used only for routing. Before classification, the fan-out SHALL use the `fusion.plan` pool's tagged default profiles. This requirement SHALL apply identically to `openspec-fusion` and `openspec-fusion-propose`.

#### Scenario: Fan-out launches one run per model
- **WHEN** the fusion-planning step activates with N classified roster profiles (2 ≤ N ≤ 5)
- **THEN** the engine SHALL create N concurrent active runs for the step, each bound to its routed profile
- **AND** all N assignments SHALL carry identical objectives, permissions, checks, and output schema

#### Scenario: Step completes when all planners hand off
- **WHEN** every active planner run of the fan-out has submitted a validated `complete` handoff
- **THEN** the fusion-planning step SHALL complete and route to the consolidation step
- **AND** all validated planner drafts SHALL be recorded as declared inputs of the consolidation step

#### Scenario: Planner count out of bounds is rejected
- **WHEN** the `fusion.plan` tagged defaults declare fewer than 2 or more than 5 entries, or duplicate a profile
- **THEN** startup SHALL reject the start before any run launches
- **AND** a classified roster SHALL be thresholded, de-duplicated, and clamped so the fan-out stays between two and five distinct profiles

#### Scenario: One planner blocks or fails
- **WHEN** a planner run hands off `blocked` or exhausts its retry policy while others remain active
- **THEN** the fusion-planning step SHALL follow the pinned blocked/failed routing without discarding already-validated drafts of surviving runs on retry of the failed role

### Requirement: Prompt-engineered structured draft schema
Every planner run SHALL produce its plan draft as an output artifact validated against a pinned structured schema (`core.plan-draft@1`) that enforces the shared output style: approach summary, file-level implementation plan, risks, and open questions; free-form drafts SHALL be rejected.

#### Scenario: Draft satisfies schema
- **WHEN** a planner run submits a draft containing approach summary, file-level plan entries with repository-relative paths, risks, and open questions within size bounds
- **THEN** the engine SHALL accept the artifact and store its digest with the run completion

#### Scenario: Draft violates schema
- **WHEN** a planner run submits output missing a required section, referencing absolute or escaping paths, or exceeding size bounds
- **THEN** handoff SHALL fail without consuming the run capability
- **AND** the planner MAY retry under the pinned retry policy

### Requirement: Consolidation into one OpenSpec proposal

The plan-fusion consolidation step SHALL be an agent step whose declared inputs are all validated planner drafts from the fan-out; it SHALL produce one consolidated OpenSpec proposal by creating the normal OpenSpec change artifacts, and its instructions SHALL direct it to reconcile conflicting approaches and record rejected alternatives rather than concatenate drafts. For `openspec-fusion`, consolidation completion SHALL enter OpenSpec full plan approval; for `openspec-fusion-propose`, consolidation completion SHALL enter plan approval and route a successful approval to completion without execution.

#### Scenario: Consolidation consumes all drafts
- **WHEN** the consolidation step activates
- **THEN** its rendered assignment SHALL identify every validated planner draft as scoped input
- **AND** the agent SHALL NOT receive any subset silently dropped by the engine

#### Scenario: Consolidated plan-fusion proposal enters standard review
- **WHEN** the consolidation agent in an `openspec-fusion` workflow hands off `complete`
- **THEN** the workflow SHALL present the consolidated proposal to the developer through the standard plan-approval step
- **AND** approval comments MAY return the workflow to either fusion step per the pinned graph without bypassing review

#### Scenario: Consolidated fusion proposal terminates
- **WHEN** the consolidation agent in an `openspec-fusion-propose` workflow hands off `complete`
- **THEN** the workflow SHALL enter plan approval and a successful approval SHALL enter `core.completed`
- **AND** no implementation, verification, archive, delivery, or pull-request effect SHALL be requested

### Requirement: Dashboard plan-fusion workflow selection

The home dashboard SHALL expose the registered `openspec-fusion` and `openspec-fusion-propose` workflows in the new-workflow modal, SHALL provide the same task input available to OpenSpec and no-OpenSpec workflows, and SHALL pass the selected definition ID and entered task to workflow startup.

#### Scenario: User selects plan-fusion with a task
- **WHEN** a user opens the new-workflow modal, chooses OpenSpec fusion, and enters a task
- **THEN** the modal SHALL submit `workflowType` as `openspec-fusion` and SHALL submit the entered task unchanged
- **AND** dashboard startup SHALL start the registered `openspec-fusion` definition with the entered task as its workflow objective

#### Scenario: User selects fusion-propose with a task
- **WHEN** a user opens the new-workflow modal, chooses OpenSpec fusion proposal, and enters a task
- **THEN** the modal SHALL submit `workflowType` as `openspec-fusion-propose` and SHALL submit the entered task unchanged
- **AND** dashboard startup SHALL use checkout/current-branch semantics for the proposal definition

#### Scenario: Plan-fusion task input uses the standard task interaction
- **WHEN** a user reaches the task step for an OpenSpec fusion or OpenSpec fusion proposal workflow
- **THEN** the modal SHALL provide the same multiline task editing and confirmation controls used by OpenSpec and no-OpenSpec workflows
- **AND** the task step SHALL occur before any final start confirmation

#### Scenario: Existing workflow choices remain available
- **WHEN** a user opens the new-workflow modal after this change
- **THEN** OpenSpec, OpenSpec apply, and no-OpenSpec/quick SHALL remain selectable
- **AND** their submitted workflow types SHALL retain their approved mappings
- **AND** OpenSpec apply SHALL continue to omit the task step

### Requirement: Dashboard plan-fusion startup creates the required fan-out

When the dashboard starts `openspec-fusion` or `openspec-fusion-propose` with a valid preset configuration, it SHALL seed ordered `planner-1` through `planner-N` routes from the `fusion.plan` pool's tagged defaults, and the classification pass SHALL replace them with the classified roster before the fusion-planning step launches.

#### Scenario: Valid preset starts plan-fusion
- **WHEN** the selected preset's `fusion.plan` pool declares between two and five distinct tagged default profiles
- **THEN** startup SHALL create one route per tagged default and a consolidator route from the `fusion.consolidate` pool
- **AND** the workflow SHALL start at the classification pass

#### Scenario: Invalid planner configuration is rejected before launch
- **WHEN** the selected `fusion.plan` pool has fewer than two, more than five, duplicate, or unresolved tagged default profiles
- **THEN** dashboard startup SHALL report a configuration error
- **AND** it SHALL launch no workspace agents
