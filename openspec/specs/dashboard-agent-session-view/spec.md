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
The agent session view SHALL let the user submit text that starts a turn when the run is idle and steers it when busy, queue a follow-up, and abort the run's current work. Submissions from the view SHALL be recorded in the run's transcript like engine submissions. The mode a client sends SHALL only decide where the prompt lands: a prompt is never rejected or dropped because its mode is unknown to the host.

#### Scenario: Steer a busy agent
- **WHEN** the user submits text while the run is working
- **THEN** the host SHALL receive it as a steer and the transcript SHALL show it after the current tool calls

#### Scenario: Abort
- **WHEN** the user triggers abort
- **THEN** the run's current work SHALL be aborted and the view SHALL show the run as idle

#### Scenario: Prompt racing an abort
- **WHEN** a prompt arrives while the run's abort is still tearing the turn down
- **THEN** the host SHALL place it after the abort settled, queued like any other prompt, instead of letting the abort withdraw it

#### Scenario: Mode the host does not know
- **WHEN** a client submits a prompt whose busy mode is neither `steer` nor `followUp`
- **THEN** the host SHALL accept the prompt as a follow-up and SHALL NOT reject the submission

### Requirement: Session view keybind help
The session view's keybinds SHALL be declared in the dashboard keybind catalog with an agent-session context, shown in the footer for non-standard keys and listed in the `?` help modal; the view content SHALL NOT print keybinding instructions.

#### Scenario: Help lists session keys
- **WHEN** the session view is open and the user presses `?`
- **THEN** the help modal SHALL list the submit, follow-up, abort and close keybinds

### Requirement: Compact command in the session prompt

The agent session prompt SHALL offer `/compact` in its command list, with an
optional free-text argument (`/compact focus on the open findings`) that is
passed to the run's agent host as the summarizer instructions, and SHALL route
it through the host control protocol exactly as `/model` and `/thinking` are
routed. The command SHALL work from both the dashboard agent session view and the
orchestrator session, which share this prompt. Its outcome SHALL be reported to
the developer as a notice: started, already compacting (naming the reason),
nothing to compact, or the failure the host returned. A finished run whose host
no longer tracks it SHALL be reported as finished with nothing compacted, never
as an unhandled error. A bare `/model`-style command without arguments SHALL keep
its current behavior.

#### Scenario: Command offered

- **WHEN** the developer types `/com` in an open agent session prompt
- **THEN** `/compact` SHALL appear in the command list with its description

#### Scenario: Instructions forwarded

- **WHEN** the developer submits `/compact focus on the open findings`
- **THEN** the host SHALL receive `compact` with those instructions and the prompt SHALL be cleared

#### Scenario: Notices per outcome

- **WHEN** the host answers `already-compacting`, `nothing-to-compact` or an error
- **THEN** the session SHALL show a notice naming that outcome instead of a success message

#### Scenario: Orchestrator session uses the same command

- **WHEN** the developer submits `/compact` in the Home → Orchestrator session
- **THEN** the orchestrator's own host SHALL serve it through the same protocol request

