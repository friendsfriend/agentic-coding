# Spec Delta

## Purpose

Lets the workflow engine complete the terminal-multiplexer half of workflow
execution on more than one multiplexer product: workspaces, tabs, panes, agents,
notifications, and runtime events are reached through one runtime-neutral
boundary whose Herdr and Luvus implementations are interchangeable, so agent
orchestration behavior no longer depends on a single vendor CLI.

## ADDED Requirements

### Requirement: Effect-native multiplexer port

The system SHALL define one runtime-neutral multiplexer port whose operations are required Effect effects covering workspace creation, lookup, listing, focus and closure; worktree creation; tab listing, creation, rename, focus and closure; pane listing, lookup, split, run, close, layout inspection, focus and foreground-process inspection; agent start, lookup and prompt; notification delivery; and scoped runtime event subscription. Port operations SHALL accept and return normalized identities and intents, and SHALL NOT accept raw vendor argument vectors, expose a raw-command escape hatch, mark operations optional, or gate behavior behind capability flags. Port failures SHALL let a caller distinguish confirmed absence from transport unavailability.

#### Scenario: Workflow launch uses only port operations

- **WHEN** an agent launch path runs on any supported multiplexer
- **THEN** every workspace, tab, pane, and agent action SHALL be performed through port operations
- **AND** the caller SHALL NOT construct vendor CLI arguments or parse vendor response envelopes

#### Scenario: No escape hatch or capability flags

- **WHEN** a caller needs multiplexer behavior
- **THEN** the port SHALL expose one required method per intent
- **AND** the caller SHALL NOT need a raw-call branch or a feature-detection branch to reach it

#### Scenario: Confirmed absence is distinguishable

- **WHEN** a pane, tab, workspace, or agent is genuinely absent
- **THEN** the port SHALL report a normalized absent result
- **AND** a transport or session failure SHALL remain distinguishable from that absence

#### Scenario: Event subscription is scoped

- **WHEN** a caller subscribes to runtime events
- **THEN** the subscription SHALL be released when its Effect scope ends
- **AND** the caller SHALL not need to close a vendor socket or handle reconnect itself

### Requirement: Multiplexer runtime selection

Multiplexer selection SHALL come from the top-level `multiplexer` configuration value or the `AGENTIC_CODING_MULTIPLEXER` environment variable, with the environment variable taking precedence and `herdr` as the default. An explicitly selected runtime that cannot be reached SHALL fail loudly with a diagnostic naming the runtime; selection SHALL NOT fall back to another runtime, and an unsupported selector value SHALL fail configuration validation.

#### Scenario: Nothing is configured

- **WHEN** neither the configuration value nor the environment override selects a runtime
- **THEN** Herdr SHALL be selected
- **AND** existing Herdr-backed behavior SHALL be unchanged

#### Scenario: Environment overrides configuration

- **WHEN** configuration selects one runtime and the environment variable selects another
- **THEN** the environment variable SHALL win
- **AND** the effective selection SHALL be observable in the failure or diagnostic output

#### Scenario: Selected runtime is unavailable

- **WHEN** the selected runtime's executable, session, or socket cannot be reached
- **THEN** the operation SHALL fail with a diagnostic naming the selected runtime
- **AND** no other runtime SHALL be used

#### Scenario: Selector is invalid

- **WHEN** the selector is not a supported runtime identifier
- **THEN** configuration validation SHALL fail before any multiplexer operation
- **AND** the diagnostic SHALL name the supported identifiers

### Requirement: Herdr adapter preserves existing behavior

The Herdr adapter SHALL delegate to the existing Herdr CLI commands and envelope decoding unchanged, preserving command argument order, retry counts and intervals, launch prompt confirmation behavior, identity and naming behavior, and error text. A deprecated port alias SHALL keep existing Herdr-port imports type-checking.

#### Scenario: Herdr call sequence is unchanged

- **WHEN** a workflow operation runs with Herdr selected
- **THEN** the adapter SHALL issue the same commands with the same arguments and parse the same envelopes as before the change

#### Scenario: Launch confirmation is unchanged

- **WHEN** an agent launch prompt is submitted
- **THEN** the adapter SHALL retain the existing shell-readiness wait, prompt confirmation polling, retry count, and the single unavailable-shell retry

#### Scenario: Deprecated type alias remains

- **WHEN** existing code imports the previous Herdr port type
- **THEN** a deprecated alias SHALL continue to satisfy that import

### Requirement: Luvus adapter conformance

The Luvus adapter SHALL implement the same port operations against the installed Luvus UHP surface, using UHP request/response envelopes, Luvus workspace/tab/pane/agent identities, its atomic agent start and prompt operations, pane process inspection, and worktree creation. The adapter SHALL honor the selected named session and the Luvus socket path, and SHALL validate responses against Luvus-specific schemas rather than Herdr response schemas.

#### Scenario: Named session is honored

- **WHEN** a session name is configured
- **THEN** Luvus requests SHALL target that session
- **AND** the session or socket location SHALL NOT be hardcoded

#### Scenario: Worktree setup returns one identity

- **WHEN** workspace setup selects the Luvus runtime in worktree mode
- **THEN** the port operation SHALL return the created worktree path together with the workspace that was opened for it

#### Scenario: Agent lifecycle is normalized

- **WHEN** an agent is started, prompted, or inspected on Luvus
- **THEN** the adapter SHALL use the atomic agent operations and SHALL report the normalized agent status vocabulary

#### Scenario: Response shape drift is bounded

- **WHEN** a Luvus response does not match the adapter's schema
- **THEN** the failure SHALL surface as a bounded transport-shape error
- **AND** it SHALL NOT be reported as a programming defect or silently replaced by a default value

### Requirement: Shared adapter conformance tests

Both adapters SHALL pass one shared contract suite covering every port operation, normalized identity handling, confirmed-absence versus transport-failure classification, launch retry behavior, and notification delivery outcomes. Runtime-specific tests SHALL additionally assert the exact vendor request each adapter emits, and the existing Herdr manager and workflow smoke scripts SHALL keep passing unchanged.

#### Scenario: Contract suite covers both runtimes

- **WHEN** the conformance suite runs
- **THEN** it SHALL apply the same behavioral assertions to the Herdr and Luvus adapters
- **AND** each adapter's vendor request assertions SHALL be checked separately

#### Scenario: Migrated callers are tested through a fake port

- **WHEN** workflow pane allocation, notification and tab synchronization, dashboard observation and event handling, or detached drain forwarding are tested
- **THEN** they SHALL be driven through a fake or stub port
- **AND** the test SHALL NOT require a live multiplexer

### Requirement: Deferred Herdr-only presentation surfaces

Sidebar publication and the Herdr custom Agents view SHALL remain Herdr-specific, and the port SHALL NOT gain sidebar or custom-view operations. Selecting another runtime SHALL NOT attempt sidebar publication and SHALL NOT fail workflow execution because of it.

#### Scenario: Sidebar stays Herdr-specific

- **WHEN** the sidebar integration is enabled and another runtime is selected
- **THEN** the system SHALL NOT publish sidebar metadata
- **AND** workflow execution SHALL proceed unaffected

#### Scenario: Port surface has no sidebar operation

- **WHEN** the port surface is inspected
- **THEN** it SHALL NOT contain a sidebar publication or custom-view operation
