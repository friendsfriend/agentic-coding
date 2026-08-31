## MODIFIED Requirements

### Requirement: Change panel STATUS shows workflow phase only
The dashboard's Change panel STATUS row SHALL display the workflow's current phase label and, when the current workflow step is blocked, a separate blocked indicator adjacent to that label. It SHALL NOT substitute or blend in any individual agent's activity status, since agent status is already displayed per-role in the Agents panel.

#### Scenario: Phase label shown regardless of agent activity
- **WHEN** the Change panel renders the STATUS row for a non-blocked workflow
- **THEN** the displayed phase text SHALL be the workflow's phase label (`stepLabel` when present, otherwise the raw phase identifier)
- **AND** the phase text SHALL NOT change based on whether any agent's status is "working"
- **AND** no blocked indicator SHALL be rendered

#### Scenario: Blocked current phase is visible
- **WHEN** the current workflow step has a committed run with status "blocked" and the workflow status is "attention-required"
- **THEN** the STATUS row SHALL retain the workflow's phase label (`stepLabel` when present, otherwise the raw phase identifier)
- **AND** it SHALL render a distinct blocked indicator beside the phase label
- **AND** the indicator SHALL identify the state as blocked without naming or displaying an agent's activity status

#### Scenario: Multiple agents busy at once
- **WHEN** more than one agent (e.g. several verifier roles) has status "working" at the same time and no run for the current step is blocked
- **THEN** the STATUS row SHALL still show the single workflow phase label
- **AND** SHALL NOT pick or blend any of the busy agents' roles into the label
- **AND** no blocked indicator SHALL be rendered

### Requirement: STATUS badge activity indicator reflects workflow terminality
The STATUS badge's animated ("working") visual state SHALL be derived from whether the workflow itself is in a terminal phase (e.g. completed or closed), not from any individual agent's busy state or from the blocked indicator.

#### Scenario: Workflow in a non-terminal phase
- **WHEN** the workflow's phase/status is not completed or closed
- **THEN** the STATUS phase badge SHALL render with its animated "working" appearance

#### Scenario: Workflow in a terminal phase
- **WHEN** the workflow's phase/status is completed or closed
- **THEN** the STATUS phase badge SHALL render with its static appearance
- **AND** this SHALL hold even if an agent pane still reports a non-terminal status
- **AND** the separate blocked indicator SHALL not change the terminality rule
