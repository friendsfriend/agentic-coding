# dashboard-engine-integration Specification

## Purpose
TBD - created by archiving change dashboard-in-process-engine. Update Purpose after archive.

## Requirements

### Requirement: In-process engine use
Dashboard SHALL invoke unified workflow command runtime in-process and submit only action identifiers returned in latest workflow view.

#### Scenario: Workflow action runs in-process
- **WHEN** dashboard triggers available approval, review, resume, delivery, PR, close, or other action
- **THEN** it SHALL call engine dispatcher with action ID and displayed revision
- **AND** it SHALL not map phase names to command handlers or spawn workflow subprocess

#### Scenario: Action confirmation dispatches on first valid Enter
- **WHEN** developer selects an available action whose confirmation mode is `confirm` or `reason`
- **THEN** dashboard SHALL dispatch the action on the first Enter press once any required reason text is non-empty
- **AND** dashboard SHALL NOT require a second, separate confirming Enter press before dispatch

#### Scenario: Dashboard action is stale
- **WHEN** workflow revision changes after view render
- **THEN** action SHALL fail without mutation
- **AND** dashboard SHALL refresh current view and available actions

#### Scenario: Agent shim unaffected
- **WHEN** managed agent submits new generic handoff
- **THEN** it SHALL invoke `agentic-coding workflow handoff` directly
- **AND** dashboard in-process execution SHALL not require or preserve legacy shim

### Requirement: Single shared Herdr client
There SHALL be one Herdr client module that parses the `.result` envelope and provides pane-geometry helpers, consumed by both the engine and the dashboard.

#### Scenario: One envelope parser
- **WHEN** a developer inspects Herdr access across the codebase
- **THEN** the `.result` envelope SHALL be parsed in exactly one module
- **AND** pane-geometry/direction math SHALL be defined once and reused (not duplicated between engine launch logic and dashboard focus logic)

### Requirement: Event-driven refresh
Dashboard SHALL refresh from canonical workflow events, outbox status, runtime observations, and telemetry updates rather than fixed phase assumptions.

#### Scenario: Refresh reacts to workflow output
- **WHEN** state revision or effect status changes
- **THEN** dashboard SHALL refresh validated workflow view
- **AND** it SHALL render current step/run state and available actions from view

#### Scenario: Runtime observation changes
- **WHEN** Herdr agent status or telemetry changes without state revision
- **THEN** dashboard MAY refresh observation panels
- **AND** observation SHALL not be presented as committed step completion

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
