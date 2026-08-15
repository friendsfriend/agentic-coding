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
Dashboard SHALL consume one typed workflow view containing revision, pinned definition, current step, active runs, resolved runtime/profile per run, validation/attention state, and available actions.

#### Scenario: Workflow uses additional registered step
- **WHEN** dashboard loads definition containing step not hardcoded in UI
- **THEN** it SHALL render registry-provided label/status/action metadata
- **AND** no UI phase list change SHALL be required for basic operation

#### Scenario: Repair UI opens
- **WHEN** developer requests repair
- **THEN** dashboard SHALL request compatible targets from engine
- **AND** repair modal SHALL show revision, target, reason requirement, and affected runs before dispatch
- **AND** a single Enter with non-empty reason SHALL dispatch repair with current revision
