## ADDED Requirements

### Requirement: Managed agents run without multiplexer panes
Every managed agent run SHALL be launched, prompted, observed and stopped without creating or using a multiplexer pane.

#### Scenario: Any runtime launch
- **WHEN** a workflow launches an agent run on any supported runtime
- **THEN** no multiplexer pane SHALL be created and the run SHALL be observable through the engine

### Requirement: Dashboard session view is the agent surface
Pressing Enter on any Agents-panel row SHALL open the agent session view for that run.

#### Scenario: OpenCode run selected
- **WHEN** the user presses Enter on an OpenCode agent row
- **THEN** the dashboard SHALL open the agent session view rather than focusing a pane
