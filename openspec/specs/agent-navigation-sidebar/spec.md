# agent-navigation-sidebar Specification

## Purpose
The agent navigation sidebar gives developers a persistent, live index of workflow-managed agent runs in the unified TUI and lets them reach the exact run session from any shell page. It complements rather than replaces the configurable workspace sidebar.

## Requirements

### Requirement: Agent source and Active/All filters
The sidebar SHALL list the latest recorded run for each user-facing agent role in every workflow returned by the unified workflows observation, excluding the existing `git` and `dashboard` utility roles. Active SHALL mean a latest run with `pending` or `working` status; All SHALL include those latest runs regardless of status. Active SHALL be the default, and standalone embedded Orchestrator, OpenCode, and Pi sessions SHALL NOT be invented as workflow-agent rows.

#### Scenario: Default Active filter
- **WHEN** the sidebar first becomes available with pending, working, and terminal agent runs
- **THEN** it SHALL select Active by default and show only latest runs whose status is pending or working

#### Scenario: All includes terminal runs
- **WHEN** the developer switches the filter to All
- **THEN** the sidebar SHALL include each user-facing role's latest run even when its status is terminal
- **AND** it SHALL NOT add standalone shell sessions or utility roles as agent rows

#### Scenario: Workflow targets define source scope
- **WHEN** the unified workflows observation returns repository, Wiki, or research workflows with agent runs
- **THEN** those workflow-backed runs SHALL be eligible for the sidebar
- **AND** workflows or runtime sessions absent from that observation SHALL NOT be fabricated

### Requirement: Agent identity and truthful presentation
Each row SHALL identify its workflow and agent role, show the run's available status, runtime and model, and omit unavailable metrics rather than infer them. Compact and expanded modes SHALL both communicate selection and status; expanded mode SHALL fit useful identity and activity details without overflowing the terminal.

#### Scenario: Available run metadata
- **WHEN** a run provides role, status, runtime, model, workflow identity, and current step
- **THEN** expanded presentation SHALL show the available identifying and status/activity information
- **AND** SHALL NOT label workflow age as agent elapsed time

#### Scenario: Missing optional metadata
- **WHEN** runtime, model, or a timing value is absent
- **THEN** the sidebar SHALL omit that value rather than display a guessed metric or placeholder value

#### Scenario: Compact and expanded presentation
- **WHEN** the panel changes between compact and expanded modes
- **THEN** it SHALL retain a visible selected-row cue and status cue
- **AND** expanded content SHALL be clipped or reflowed within its allocated width

### Requirement: Live refresh and stable selection
Live workflow observations SHALL update agent rows without replacing the selected run merely because its status or other metadata changed. Selection identity SHALL follow the workflow target, workflow identity, and stable run identity; filtering SHALL retain a hidden selection so it can be restored when that row becomes visible again.

#### Scenario: Metadata refresh preserves selected run
- **WHEN** a live refresh changes the selected run's status, model, or workflow activity
- **THEN** the selected identity SHALL remain the same run
- **AND** its row SHALL update in place without a selection jump

#### Scenario: Filter hides and restores selection
- **WHEN** the selected terminal run is hidden by Active and the developer switches to All
- **THEN** the previous run SHALL be selected again if it is still present

#### Scenario: Selected run disappears
- **WHEN** the selected run is removed from the authoritative workflow observation
- **THEN** selection SHALL move to a valid visible row or remain empty, never point outside the list

### Requirement: Loading, disconnected, and empty states
The sidebar SHALL distinguish an initial workflow read, a successful empty result, and an unavailable or failed read. A failed refresh SHALL retain the last successful rows when available and SHALL NOT present stale data as a newly confirmed empty list.

#### Scenario: Initial load
- **WHEN** the first workflow observation has not completed
- **THEN** the panel SHALL show a loading state rather than an empty-state message

#### Scenario: No eligible agents
- **WHEN** a successful observation contains no eligible agent runs for the selected filter
- **THEN** the panel SHALL show an explicit empty state for that filter

#### Scenario: Workflow source disconnected
- **WHEN** a workflow observation fails after rows were loaded
- **THEN** the panel SHALL retain the last successful rows and communicate that the data is unavailable or stale
- **AND** a later successful refresh SHALL replace them with current data

### Requirement: Shell focus and key ownership
On shell surfaces where workflow navigation is available, Ctrl+A SHALL toggle focus to the agent sidebar and back to the prior shell focus, falling back to page content when necessary. An open modal or active text-input owner SHALL retain Ctrl+A and all other input; the shell SHALL NOT steal it for sidebar focus.

#### Scenario: Toggle focus from page content
- **WHEN** the page body owns input and the developer presses Ctrl+A
- **THEN** focus SHALL move to the agent sidebar and its keybind catalog SHALL become active

#### Scenario: Toggle back to prior focus
- **WHEN** the agent sidebar owns input and the developer presses Ctrl+A
- **THEN** focus SHALL return to the shell panel or page body that owned focus before the toggle

#### Scenario: Modal or text input owns input
- **WHEN** a modal or text-input control owns input and Ctrl+A is pressed
- **THEN** the existing modal or text-input behavior SHALL run
- **AND** shell panel focus SHALL NOT change

### Requirement: Keyboard and pointer selection, scrolling, and navigation
The sidebar SHALL support keyboard selection, pointer row selection and activation, and scrolling without changing the selected run merely from a wheel event. Activating a row SHALL navigate to its workflow and preserve the exact run identity; when a session handle exists, the workflow SHALL open that run's session, and when it does not, the workflow SHALL focus the matching run without substituting another agent.

#### Scenario: Keyboard opens exact durable session
- **WHEN** the developer selects a run and presses Enter
- **THEN** the shell SHALL open that run's workflow and session using the selected run identity

#### Scenario: Pointer selects then activates
- **WHEN** the developer taps an unselected row and then activates that selected row
- **THEN** the first tap SHALL select it and the activation SHALL navigate to its exact workflow run

#### Scenario: Session handle is unavailable
- **WHEN** the selected run has no usable session handle
- **THEN** the workflow SHALL focus the corresponding run and SHALL NOT open a different run's session

#### Scenario: Scroll without changing selection
- **WHEN** the developer scrolls the agent list with the wheel
- **THEN** the list SHALL scroll and the selected run identity SHALL remain unchanged

### Requirement: Exact-session connection state and recovery
An opened recorded session SHALL distinguish initial connecting, connected after a received frame, and disconnected after a previously received frame. Submit, configure, abort and compact SHALL be paused until a fresh authenticated frame establishes connected state. This is a local connection-safety contract, not a change to session command semantics or workflow lifecycle.

#### Scenario: Waiting for the first session frame
- **WHEN** an exact session is opening but has not received a frame
- **THEN** it SHALL communicate initial connecting with controls paused
- **AND** it SHALL NOT describe a never-received transcript as stale or previously connected

#### Scenario: Initial watch is unavailable
- **WHEN** the exact session watch fails before its first frame
- **THEN** the workflow SHALL return to the matching run row without substituting another session
- **AND** another initial attempt SHALL require an explicit row opening rather than an invisible retry loop

#### Scenario: Established session watch drops
- **WHEN** a watch drops after at least one session frame was received
- **THEN** the view SHALL retain its last-known transcript and unsent draft and explicitly mark the transcript stale and reconnecting
- **AND** submit, configure, abort and compact SHALL be paused, scheduled old projection work cancelled, and live/pending, working, compaction and token-rate indicators cleared
- **AND** every reconnect SHALL retain the existing fresh exact-run ownership validation and connected-host authentication

#### Scenario: Fresh session frame recovers the view
- **WHEN** a reconnect supplies a fresh authenticated frame for the same opened session
- **THEN** the view SHALL replace the stale transcript and metadata, restore controls and remove the stale cue
- **AND** it SHALL preserve the unsent draft

### Requirement: Bounded reused session presentation
The transcript projection SHALL compute compaction labels only for projected entries and reuse nearest-token gap searches. Metadata SHALL be cached by immutable entry/timing source identity and invalidated when those sources change. The per-view markdown cache SHALL retain no more messages than the projection's block limit. Measured labels, provider-error clearing and timing/token semantics SHALL remain unchanged.

#### Scenario: Live-only frame preserves history sources
- **WHEN** live documents change but immutable entry and timing sources are unchanged
- **THEN** metadata summaries and already-computed compaction measurements SHALL be reused without rescanning the complete history or timing map

#### Scenario: Committed history or timings change
- **WHEN** an entry source is appended, edited or replaced, or a new timing map is received
- **THEN** the affected summaries and compaction measurements SHALL be recalculated from the changed source without reusing stale measurements

#### Scenario: Old markdown leaves the transcript window
- **WHEN** a long-open session renders more messages than the projection can retain
- **THEN** its markdown cache SHALL release old source text and parsed parts within the projection-sized cache bound
- **AND** an active streaming message SHALL still reuse its settled markdown parts while cached

### Requirement: Coexistence and narrow-terminal sizing
The agent sidebar SHALL occupy the right edge of the unified shell while remaining distinct from the workspace sidebar, regardless of the workspace sidebar's configured side. When both panels are present, their compact and expanded widths SHALL adapt to the terminal so panel content does not overlap and the page body retains a usable minimum width.

#### Scenario: Workspace sidebar configured on the left
- **WHEN** both sidebars are visible and the workspace sidebar is configured on the left
- **THEN** the workspace sidebar SHALL remain left of the page body and the agent sidebar SHALL remain at the shell's right edge

#### Scenario: Workspace sidebar configured on the right
- **WHEN** both sidebars are visible and the workspace sidebar is configured on the right
- **THEN** both panels SHALL remain separately reachable, with the agent sidebar at the outer right edge

#### Scenario: Narrow terminal
- **WHEN** the terminal is too narrow for both expanded sidebars and the page body
- **THEN** sidebar widths SHALL collapse or reduce without overlap and preserve usable page-body space
