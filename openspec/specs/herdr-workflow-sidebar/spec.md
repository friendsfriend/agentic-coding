# herdr-workflow-sidebar Specification

## Purpose
TBD - created by archiving change improve-herdr-workflow-sidebar. Update Purpose after archive.
## Requirements
### Requirement: Native workflow context cards
When the sidebar integration is enabled, the system SHALL publish display-only metadata that renders each managed workflow as a native Herdr Space card containing an input marker and project name, workflow name, workflow type, and current phase, in that order. The project name SHALL be the basename of the canonical repository path, workflow name SHALL use the existing workflow ID, workflow type SHALL use the registered definition ID, and phase SHALL use the registered current-step label with its ID as fallback.

#### Scenario: Workflow runs in a linked worktree
- **WHEN** workflow `improve-authentication` belongs to canonical repository `/projects/agentic-coding` and runs in a differently named linked worktree
- **THEN** its project line SHALL display `agentic-coding`, not the worktree folder name
- **AND** subsequent lines SHALL display `improve-authentication`, its definition ID, and its current registered phase

#### Scenario: Project basenames collide
- **WHEN** two canonical repositories have the same basename
- **THEN** the system SHALL retain distinct repository, workflow, workspace, and pane identities
- **AND** it SHALL NOT combine their cards or input requirements based on display text

#### Scenario: Repository-independent workflow
- **WHEN** an existing research or wiki target has no repository
- **THEN** its card SHALL use the existing target classification to display `Research` or `Wiki`
- **AND** it SHALL NOT present the central storage directory as a repository name

### Requirement: Native agent context cards
The system SHALL render each managed agent card with an input marker and project name, workflow name, lifecycle role, and live runtime activity status, in that order. Lifecycle role SHALL come from the current associated workflow run rather than the runtime executable or hashed Herdr agent name. Runtime activity SHALL remain observational and distinct from committed run completion.

#### Scenario: Worker uses Pi
- **WHEN** a live Pi pane belongs to role `worker`
- **THEN** the lifecycle row SHALL display `worker`
- **AND** the final row SHALL show the observed runtime state without substituting the committed run status

#### Scenario: Persistent agent has historical runs
- **WHEN** historical and current runs reference the same persistent pane
- **THEN** the pane SHALL receive one card for its current association
- **AND** historical run questions or roles SHALL NOT overwrite current card metadata

### Requirement: Fixed-position input glyph and tree styling
Managed cards SHALL place `◆` for developer input owed or `◇` for no known developer input owed immediately before the project name, followed by one space. The glyphs SHALL occupy the same terminal-cell slot and SHALL NOT change the project's starting column or card row count when input state changes. Cards SHALL use `├─`, `│`, and `└─` for subordinate workflow/type/role/phase/status lines. Meaning SHALL remain distinguishable without color.

#### Scenario: Attention toggles without layout movement
- **WHEN** a card changes from no known input owed to confirmed input owed
- **THEN** its first line SHALL change from `◇ <project>` to `◆ <project>`
- **AND** the project name and subordinate lines SHALL retain their positions
- **AND** no exclamation mark, ellipsis, emoji variation selector, or third attention glyph SHALL be substituted

#### Scenario: Several workflow cards share a project
- **WHEN** two workflows belong to the same project
- **THEN** each card SHALL repeat its project line and render its own subordinate tree lines
- **AND** the integration SHALL NOT create a synthetic shared project header or change Herdr's Spaces ordering/grouping

#### Scenario: Native row normalization
- **WHEN** Herdr normalizes reported tokens and renders configured rows
- **THEN** the marker SHALL remain directly before the project text
- **AND** native token separators SHALL NOT insert punctuation between the marker and project
- **AND** the internal spaces following tree glyphs SHALL remain visible

### Requirement: Agent-specific input attribution
An agent SHALL be marked as owing input when its exact current run has an unexpired pending developer question or its current live Herdr state reports a blocked runtime input prompt. A peer-agent consultation or runtime `idle`/`done` state alone SHALL NOT create a developer input requirement.

#### Scenario: Developer question is pending
- **WHEN** an agent submits a valid developer question for its current run
- **THEN** that agent and its workflow card SHALL display `◆`
- **AND** other agents in the workflow without their own requirement SHALL NOT inherit the filled marker

#### Scenario: Questionnaire is partially answered
- **WHEN** one item is answered but another item remains pending for the same current run
- **THEN** its agent card SHALL retain `◆`
- **AND** resolving the final pending item SHALL remove that obligation unless another input requirement remains

#### Scenario: Question is resolved or no longer applies
- **WHEN** a question is answered, cancelled, expired by its deadline, or belongs to an expired/replaced run
- **THEN** that question SHALL NOT mark a current agent as owing input
- **AND** observing an elapsed deadline SHALL NOT itself persist a question-expiry mutation

#### Scenario: Peer consultation is pending
- **WHEN** a pending question targets another agent role rather than the developer
- **THEN** that consultation SHALL NOT set the developer-input marker

#### Scenario: Runtime approval without workflow revision change
- **WHEN** an associated Herdr agent changes to `blocked` while no workflow revision changes
- **THEN** the agent SHALL display `◆` on the next live presentation reconciliation
- **AND** a later successful observation of a non-blocked state SHALL clear this runtime-only obligation

### Requirement: Workflow-wide input attribution
A workflow card SHALL indicate input owed for associated agent input requirements, registered blocking human decision gates, or committed paused/attention-required states requiring operator intervention. Registered behavior SHALL supply blocking action hints; the publisher SHALL NOT maintain a second phase/role table or assume every available action requires immediate input. Workflow-wide gates SHALL NOT be attributed to every agent.

#### Scenario: Approval gate has no requesting agent
- **WHEN** a workflow reaches a registered plan, developer-review, or wiki approval gate
- **THEN** the workflow card SHALL display `◆`, including when no current agent tab exists
- **AND** agent cards SHALL reflect only their own questions and live runtime input requirements

#### Scenario: Optional terminal or research action
- **WHEN** a completed workflow offers optional close/PR actions or an active researcher offers an optional follow-up
- **THEN** those actions alone SHALL NOT fill the input marker

#### Scenario: New registered blocking step
- **WHEN** an unfamiliar registered step exposes an available action marked as requiring developer input
- **THEN** the workflow card SHALL display its registered phase label and filled marker
- **AND** no publisher phase-name table change SHALL be required

### Requirement: Stable input-first agent ordering
The custom native Agents view SHALL order managed cards with confirmed or conservatively retained input requirements first, uncertain cards without a known requirement next, and freshly observed no-input cards next. Within each category it SHALL preserve native workspace, tab, and pane order. Unmanaged entries lacking the managed sort key SHALL remain visible after managed entries. Sorting SHALL use a machine-readable metadata key rather than glyph text and SHALL NOT alter Spaces order.

#### Scenario: Priority changes
- **WHEN** a previously no-input agent receives a developer question
- **THEN** its card SHALL move into the input-required category
- **AND** cards with unchanged category and topology SHALL retain their relative order

#### Scenario: Activity changes without attention change
- **WHEN** an agent transitions between working, idle, or done without changing input requirement
- **THEN** recency alone SHALL NOT reorder it within its category

#### Scenario: Native navigation follows displayed order
- **WHEN** the developer clicks a card or uses indexed or next/previous native Agent navigation
- **THEN** Herdr SHALL select the agent corresponding to the displayed custom order

### Requirement: Uncertain and unmanaged observations remain honest
Publication SHALL NOT convert failed or missing observations into verified absence, idle state, or cleared input. Known unresolved developer obligations SHALL remain filled. Previously observed positive runtime requirements SHALL remain filled until fresh evidence clears them; otherwise incomplete observations SHALL use the hollow marker with an explicit unknown/stale state. The integration SHALL provide recognizable native-name fallback rows for unmanaged entries without inventing workflow identity.

#### Scenario: Herdr lookup fails after an input prompt
- **WHEN** an agent was known to require runtime input and a subsequent observation fails
- **THEN** its card SHALL retain `◆` and identify stale/unknown observation
- **AND** the failure SHALL NOT authorize agent relaunch or be reported as confirmed no-input state

#### Scenario: No prior live observation
- **WHEN** a managed agent has no successful live observation and no known pending developer obligation
- **THEN** its marker SHALL be hollow with an explicit unknown state
- **AND** it SHALL NOT be represented as freshly observed idle or working

#### Scenario: Unmanaged agent remains identifiable
- **WHEN** a manually launched agent has no workflow run association
- **THEN** configured native rows SHALL still show its existing Herdr context/name and activity
- **AND** it SHALL NOT receive a fabricated workflow, lifecycle role, or managed input sort key

### Requirement: Presentation publication has explicit lifecycle ownership
The system SHALL reconcile sidebar metadata after relevant committed changes and before a managed command enters a long developer-question wait. A long-lived Agentic Coding application SHALL own cancellable startup/reconnect and event-driven reconciliation plus a bounded two-second fallback refresh for live observations, independent of the focused tab and durable execution coordinator. Pure workflow status/list/view reads SHALL remain free of Herdr writes.

#### Scenario: Question waits during a drain
- **WHEN** a developer question commits while a drain or agent command remains active
- **THEN** bounded presentation reconciliation SHALL occur before the command enters its long answer wait
- **AND** publication SHALL NOT wait for the entire drain to finish

#### Scenario: Application starts or reconnects
- **WHEN** an enabled long-lived application starts or reconnects to Herdr
- **THEN** it SHALL rebuild cards from current authoritative views and live topology
- **AND** it SHALL restore its transient native agent view for that connection

#### Scenario: UI is unfocused
- **WHEN** the application remains alive but another Herdr tab is focused
- **THEN** runtime-only input changes SHALL remain eligible for event-driven or fallback reconciliation
- **AND** no additional durable effect runner SHALL be started by presentation refresh

#### Scenario: Refresh bursts and pane reassignment
- **WHEN** multiple refreshes overlap or a pane is reassigned before an observation completes
- **THEN** publication SHALL coalesce work, revalidate identity, and prevent obsolete results from overwriting the new association
- **AND** obsolete owned workflow/sort tokens SHALL be cleared
- **AND** self-generated metadata events SHALL NOT cause an unbounded refresh loop

#### Scenario: Application stops
- **WHEN** the presentation owner is disposed
- **THEN** its timers, subscriptions, and pending transport work SHALL be cancelled or boundedly completed
- **AND** no new daemon SHALL be left running
- **AND** documentation SHALL state that continuous live refresh stops when all Agentic Coding applications exit

### Requirement: Best-effort safe publication
Sidebar projection SHALL use validated, bounded, display-only data and shared Herdr boundary adapters. Publication failures SHALL NOT change workflow revisions, action authorization, agent semantic status, capabilities, or durable effect attempts. The publisher SHALL NOT rename/move/close resources or launch/prompt agents to achieve presentation changes.

#### Scenario: Herdr is unavailable or unsupported
- **WHEN** metadata or agent-view publication fails, times out, or encounters an unsupported API
- **THEN** the committed workflow operation SHALL retain its original result
- **AND** the application SHALL expose a bounded non-secret presentation diagnostic without a repeated error flood

#### Scenario: Labels contain sensitive or malformed data
- **WHEN** metadata is prepared for a card
- **THEN** it SHALL contain only bounded identity labels, type/phase/role/status, and attention information
- **AND** it SHALL exclude capabilities, task bodies, question text, answers, and terminal control characters
- **AND** truncating display values SHALL NOT change canonical identity

#### Scenario: Existing workflow guarantees
- **WHEN** sidebar synchronization runs repeatedly during active workflows
- **THEN** it SHALL NOT create schema migrations, workflow repins, durable sidebar effects, or additional agent processes
- **AND** pure status/list reads SHALL remain observational

### Requirement: Explicit opt-in and custom-view ownership
The integration SHALL default to disabled and SHALL be enabled through the trusted user-owned `ui.herdr_sidebar` preference. Project configuration SHALL NOT override this server-wide choice. Setup SHALL provide a manual merge/reload recipe for Herdr row configuration and SHALL NOT overwrite the user's configuration automatically. Custom view installation SHALL be explicit about replacing another active view, and removal SHALL be guarded by source ownership.

#### Scenario: Project tries to enable global sidebar behavior
- **WHEN** project configuration contains a conflicting sidebar preference
- **THEN** the trusted user preference SHALL remain authoritative
- **AND** no server-wide custom view SHALL be installed solely because a repository requested it

#### Scenario: Another tool replaces the view
- **WHEN** another tool or the developer replaces the custom view after this integration installs it
- **THEN** ordinary metadata refresh SHALL NOT continuously reinstall the Agentic Coding view
- **AND** disabling this integration SHALL NOT clear the other source's view

#### Scenario: User rolls back
- **WHEN** the user disables the preference and restores their saved Herdr row configuration
- **THEN** the integration SHALL clear only its owned custom view and metadata
- **AND** workflow stores, agent processes, native names, and unrelated user settings SHALL remain unchanged

