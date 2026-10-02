# dashboard-agent-session-view Specification

## Purpose
TBD - created by archiving change add-pi-durable-runtime. Update Purpose after archive.
## Requirements
### Requirement: Open agent session view from the Agents panel
Pressing Enter on an Agents-panel row whose run uses the `pi-durable` runtime SHALL open an agent session view for that run; rows of other runtimes SHALL keep focusing their multiplexer pane.

#### Scenario: Durable agent selected
- **WHEN** the user presses Enter on a `pi-durable` agent row
- **THEN** the dashboard SHALL open the agent session view for that run

#### Scenario: Pane-hosted agent selected
- **WHEN** the user presses Enter on a `pi` or `opencode` agent row
- **THEN** the dashboard SHALL focus the agent's pane as before

### Requirement: Live session rendering
The agent session view SHALL attach to the workflow host and render the run's committed transcript, the answer being streamed, running tools and their output, queued submissions, model, usage and status, updating as the host publishes changes. A view opened while the run is already working SHALL start from the current state.

#### Scenario: Late join during a tool call
- **WHEN** the view opens while a bash tool call is producing output
- **THEN** it SHALL show the output produced so far and continue updating

#### Scenario: Host unavailable
- **WHEN** the workflow host is not running
- **THEN** the view SHALL show a bounded unavailable state without blocking the dashboard

### Requirement: Steering, follow-up and abort
The agent session view SHALL let the user submit text that starts a turn when the run is idle and steers it when busy, queue a follow-up, and abort the run's current work. Submissions from the view SHALL be recorded in the run's transcript like engine submissions.

#### Scenario: Steer a busy agent
- **WHEN** the user submits text while the run is working
- **THEN** the host SHALL receive it as a steer and the transcript SHALL show it after the current tool calls

#### Scenario: Abort
- **WHEN** the user triggers abort
- **THEN** the run's current work SHALL be aborted and the view SHALL show the run as idle

### Requirement: Session view keybind help
The session view's keybinds SHALL be declared in the dashboard keybind catalog with an agent-session context, shown in the footer for non-standard keys and listed in the `?` help modal; the view content SHALL NOT print keybinding instructions.

#### Scenario: Help lists session keys
- **WHEN** the session view is open and the user presses `?`
- **THEN** the help modal SHALL list the submit, follow-up, abort and close keybinds

