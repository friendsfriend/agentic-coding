## ADDED Requirements

### Requirement: Dashboard plan-fusion workflow selection
The home dashboard SHALL expose the registered `plan-fusion` workflow in the new workflow modal and SHALL pass the selected definition ID to workflow startup without changing the identifiers or behavior of existing workflow choices.

#### Scenario: User selects plan-fusion
- **WHEN** a user opens the new workflow modal and chooses Plan Fusion
- **THEN** the modal SHALL submit `workflowType` as `plan-fusion`
- **AND** dashboard startup SHALL start the registered `plan-fusion` definition

#### Scenario: Existing workflow choices remain available
- **WHEN** a user opens the new workflow modal after this change
- **THEN** standard, direct-apply, and quick SHALL remain selectable
- **AND** their submitted workflow types SHALL retain their existing mappings

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
