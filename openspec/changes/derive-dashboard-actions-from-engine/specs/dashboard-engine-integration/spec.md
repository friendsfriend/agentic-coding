## MODIFIED Requirements

### Requirement: Engine-provided workflow view
Dashboard SHALL consume one typed workflow view containing revision, pinned definition, current step, active runs, resolved runtime/profile per run, validation/attention state, and available actions. The view's available actions SHALL be the dashboard's only source of action availability; the dashboard SHALL NOT derive, extend, or filter that set from step or workflow definition identifiers. The dashboard SHALL remain the owner of user-facing presentation for those actions.

#### Scenario: Workflow uses additional registered step
- **WHEN** dashboard loads definition containing step not hardcoded in UI
- **THEN** it SHALL render registry-provided label/status/action metadata
- **AND** no UI phase list change SHALL be required for basic operation

#### Scenario: Repair UI opens
- **WHEN** developer requests repair
- **THEN** dashboard SHALL request compatible targets from engine
- **AND** repair modal SHALL show revision, target, and affected runs before dispatch, without a reason requirement
- **AND** a single Enter SHALL dispatch repair with current revision regardless of whether a reason was provided

#### Scenario: Dashboard offers exactly the engine's actions
- **WHEN** the dashboard presents the required developer action for a workflow whose view carries available actions
- **THEN** the offered items SHALL correspond exactly to the actions the engine reported as available
- **AND** the dashboard SHALL NOT offer an action the engine did not report
- **AND** the dashboard SHALL NOT withhold an action the engine did report

#### Scenario: Presentation stays in the dashboard
- **WHEN** an action is rendered
- **THEN** its title, prompt, and item label SHALL come from dashboard-owned copy keyed by the action identifier
- **AND** the engine SHALL NOT be required to supply user-facing presentation strings

## ADDED Requirements

### Requirement: Dashboard actions are dispatchable
Every action the dashboard offers SHALL be an action the engine can dispatch for the workflow's current revision and step. The dashboard SHALL NOT present an action identifier the engine does not define.

#### Scenario: Terminal action set matches the engine
- **WHEN** a completed workflow whose lifecycle produces no reviewable code change is presented
- **THEN** the dashboard SHALL NOT offer a pull-request action
- **AND** this SHALL hold for every definition the engine treats as close-only, with no separate dashboard allowlist

#### Scenario: Undefined action is not offered
- **WHEN** the dashboard builds the item list for a required developer action
- **THEN** every item that dispatches to the engine SHALL carry an action identifier present in the view's available actions
- **AND** an item whose identifier has no engine action SHALL NOT be rendered

#### Scenario: Legacy view without actions
- **WHEN** a workflow view carries no available-actions array
- **THEN** the dashboard SHALL fall back to its legacy phase-derived action set
- **AND** the fallback SHALL be limited to views that carry no actions array
