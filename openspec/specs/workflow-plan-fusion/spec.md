# workflow-plan-fusion Specification

## Purpose
Defines the plan-fusion workflow type: parallel multi-model planning where 2–5 planner runs receive the same prompt-engineered objective, each produces a structured plan draft against a pinned output schema, and a consolidation step fuses the drafts into one OpenSpec proposal before the standard approval and execution flow.
## Requirements
### Requirement: Plan-fusion workflow composition
The system SHALL register a built-in workflow definition `plan-fusion` whose graph prepends a fusion-planning fan-out step and a plan-fusion consolidation step ahead of the standard flow's plan-approval step, reusing the standard flow's steps unchanged from plan approval onward.

#### Scenario: Plan-fusion workflow starts
- **WHEN** a workflow is started with the `plan-fusion` definition
- **THEN** the initial step SHALL be the fusion-planning step
- **AND** the graph SHALL route consolidation completion to the standard plan-approval step and onward through the unchanged standard flow

#### Scenario: Existing workflows are unaffected
- **WHEN** `plan-fusion` is registered
- **THEN** `standard`, `direct-apply`, and `no-openspec` definitions SHALL keep their identifiers, versions, graphs, and pins

### Requirement: Parallel multi-model planning fan-out
The fusion-planning step SHALL launch between 2 and 5 planner runs in parallel, one per configured model routing, each receiving the same rendered assignment (same instruction assets, same objective text) with a distinct planner role used only for routing.

#### Scenario: Fan-out launches one run per model
- **WHEN** the fusion-planning step activates with N configured model routings (2 ≤ N ≤ 5)
- **THEN** engine SHALL create N concurrent active runs for the step, each bound to its routed profile
- **AND** all N assignments SHALL carry identical objectives, permissions, checks, and output schema

#### Scenario: Step completes when all planners hand off
- **WHEN** every active planner run of the fan-out has submitted a validated `complete` handoff
- **THEN** the fusion-planning step SHALL complete and route to the consolidation step
- **AND** all validated planner drafts SHALL be recorded as declared inputs of the consolidation step

#### Scenario: Planner count out of bounds is rejected
- **WHEN** a plan-fusion start declares fewer than 2 or more than 5 model routings, or duplicates a routing
- **THEN** engine SHALL reject the start before any run launches

#### Scenario: One planner blocks or fails
- **WHEN** a planner run hands off `blocked` or exhausts its retry policy while others remain active
- **THEN** the fusion-planning step SHALL follow the pinned blocked/failed routing without discarding already-validated drafts of surviving runs on retry of the failed role

### Requirement: Prompt-engineered structured draft schema
Every planner run SHALL produce its plan draft as an output artifact validated against a pinned structured schema (`core.plan-draft@1`) that enforces the shared output style: approach summary, file-level implementation plan, risks, and open questions; free-form drafts SHALL be rejected.

#### Scenario: Draft satisfies schema
- **WHEN** a planner run submits a draft containing approach summary, file-level plan entries with repository-relative paths, risks, and open questions within size bounds
- **THEN** engine SHALL accept the artifact and store its digest with the run completion

#### Scenario: Draft violates schema
- **WHEN** a planner run submits output missing a required section, referencing absolute or escaping paths, or exceeding size bounds
- **THEN** handoff SHALL fail without consuming the run capability
- **AND** the planner MAY retry under the pinned retry policy

### Requirement: Consolidation into one OpenSpec proposal
The plan-fusion consolidation step SHALL be an agent step whose declared inputs are all validated planner drafts from the fan-out; it SHALL produce one consolidated OpenSpec proposal by creating the normal openspec change artifacts, and its instructions SHALL direct it to reconcile conflicting approaches and record rejected alternatives rather than concatenate drafts.

#### Scenario: Consolidation consumes all drafts
- **WHEN** the consolidation step activates
- **THEN** its rendered assignment SHALL identify every validated planner draft as scoped input
- **AND** the agent SHALL NOT receive any subset silently dropped by the engine

#### Scenario: Consolidated proposal enters standard review
- **WHEN** the consolidation agent hands off `complete`
- **THEN** the workflow SHALL present the consolidated proposal to the developer through the standard plan-approval step
- **AND** approval comments MAY return the workflow to either fusion step per the pinned graph without bypassing review

### Requirement: Dashboard plan-fusion workflow selection
The home dashboard SHALL expose the registered `plan-fusion` workflow in the new workflow modal, SHALL provide the same task input available to standard and quick workflows, and SHALL pass both the selected definition ID and the entered task to workflow startup without changing the identifiers or behavior of existing workflow choices.

#### Scenario: User selects plan-fusion with a task
- **WHEN** a user opens the new workflow modal, chooses Plan Fusion, and enters a task
- **THEN** the modal SHALL submit `workflowType` as `plan-fusion` and SHALL submit the entered task unchanged
- **AND** dashboard startup SHALL start the registered `plan-fusion` definition with the entered task as its workflow objective

#### Scenario: Plan-fusion task input uses the standard task interaction
- **WHEN** a user reaches the task step for a plan-fusion workflow
- **THEN** the modal SHALL provide the same multiline task editing and confirmation controls used by standard and quick workflows
- **AND** the task step SHALL occur before checkout mode selection

#### Scenario: Existing workflow choices remain available
- **WHEN** a user opens the new workflow modal after this change
- **THEN** standard, direct-apply, and quick SHALL remain selectable
- **AND** their submitted workflow types SHALL retain their existing mappings
- **AND** direct-apply SHALL continue to omit the task step

### Requirement: Dashboard plan-fusion startup creates the required fan-out
When the dashboard starts `plan-fusion` with a valid preset configuration, it SHALL derive ordered `planner-1` through `planner-N` routes for the configured N planner profiles and a `consolidator` route for `fusion.consolidate` before invoking the workflow engine.

#### Scenario: Valid preset starts plan-fusion
- **WHEN** the selected preset defines 2–5 ordered, distinct profiles for `fusion.plan` planner roles and a resolvable consolidator route
- **THEN** dashboard startup SHALL create one route per planner role and one consolidator route
- **AND** the workflow SHALL start at the existing `fusion.plan` step

#### Scenario: Invalid planner configuration is rejected before launch
- **WHEN** a selected plan-fusion preset defines fewer than 2, more than 5, non-contiguous, duplicate, or unresolved planner routes
- **THEN** dashboard startup SHALL report a configuration error
- **AND** it SHALL launch no workspace agents

