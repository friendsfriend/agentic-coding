## MODIFIED Requirements

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

### Requirement: Engine-provided workflow view
Dashboard SHALL consume one typed workflow view containing revision, pinned definition, current step, active runs, resolved runtime/profile per run, validation/attention state, and available actions.

#### Scenario: Workflow uses additional registered step
- **WHEN** dashboard loads definition containing step not hardcoded in UI
- **THEN** it SHALL render registry-provided label/status/action metadata
- **AND** no UI phase list change SHALL be required for basic operation

#### Scenario: Repair UI opens
- **WHEN** developer requests repair
- **THEN** dashboard SHALL request compatible targets from engine
- **AND** repair modal SHALL show revision, target, and affected runs before dispatch, without a reason requirement
- **AND** a single Enter SHALL dispatch repair with current revision regardless of whether a reason was provided
