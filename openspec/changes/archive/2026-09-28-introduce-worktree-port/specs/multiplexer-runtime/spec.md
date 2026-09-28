# Spec Delta

## Purpose

Removes worktree creation from the multiplexer boundary: a worktree is resolved
by the worktree port and the multiplexer only opens a workspace at that path, so
worktree behavior no longer depends on which multiplexer is selected.

## MODIFIED Requirements

### Requirement: Effect-native multiplexer port

The system SHALL define one runtime-neutral multiplexer port whose operations
are required Effect effects covering workspace creation, lookup, listing, focus
and closure; tab listing, creation, rename, focus and closure; pane listing,
lookup, split, run, close, layout inspection, focus and foreground-process
inspection; agent start, lookup and prompt; notification delivery; and scoped
runtime event subscription. Worktree creation SHALL NOT be a multiplexer
operation: a caller resolves the worktree through the worktree port and opens a
workspace at the resolved path. Port operations SHALL accept and return
normalized identities and intents, and SHALL NOT accept raw vendor argument
vectors, expose a raw-command escape hatch, mark operations optional, or gate
behavior behind capability flags. Port failures SHALL let a caller distinguish
confirmed absence from transport unavailability.

#### Scenario: Workflow launch uses only port operations

- **WHEN** an agent launch path runs on any supported multiplexer
- **THEN** every workspace, tab, pane, and agent action SHALL be performed
  through port operations
- **AND** the caller SHALL NOT construct vendor CLI arguments or parse vendor
  response envelopes

#### Scenario: No escape hatch or capability flags

- **WHEN** a caller needs multiplexer behavior
- **THEN** the port SHALL expose one required method per intent
- **AND** the caller SHALL NOT need a raw-call branch or a feature-detection
  branch to reach it

#### Scenario: Confirmed absence is distinguishable

- **WHEN** a pane, tab, workspace, or agent is genuinely absent
- **THEN** the port SHALL report a normalized absent result
- **AND** a transport or session failure SHALL remain distinguishable from that
  absence

#### Scenario: Event subscription is scoped

- **WHEN** a caller subscribes to runtime events
- **THEN** the subscription SHALL be released when its Effect scope ends
- **AND** the caller SHALL not need to close a vendor socket or handle
  reconnect itself

#### Scenario: Worktree setup is runtime-independent

- **WHEN** workspace setup runs in worktree mode on any supported multiplexer
- **THEN** the worktree SHALL be resolved once through the worktree port
- **AND** the multiplexer SHALL only be asked to open a workspace at the
  resolved path

### Requirement: Luvus adapter conformance

The Luvus adapter SHALL implement the same multiplexer port operations against
the installed Luvus UHP surface, using UHP request/response envelopes, Luvus
workspace/tab/pane/agent identities, its atomic agent start and prompt
operations, pane process inspection, and workspace creation for a resolved
worktree path. The adapter SHALL honor the selected named session and the Luvus
socket path, and SHALL validate responses against Luvus-specific schemas rather
than Herdr response schemas. The adapter SHALL NOT implement worktree creation.

#### Scenario: Named session is honored

- **WHEN** a session name is configured
- **THEN** Luvus requests SHALL target that session
- **AND** the session or socket location SHALL NOT be hardcoded

#### Scenario: Workspace setup opens the resolved worktree

- **WHEN** workspace setup selects the Luvus runtime in worktree mode
- **THEN** the adapter SHALL open a workspace for the path the worktree port
  resolved
- **AND** it SHALL NOT create a worktree or choose a base commit itself

#### Scenario: Agent lifecycle is normalized

- **WHEN** an agent is started, prompted, or inspected on Luvus
- **THEN** the adapter SHALL use the atomic agent operations and SHALL report
  the normalized agent status vocabulary

#### Scenario: Response shape drift is bounded

- **WHEN** a Luvus response does not match the adapter's schema
- **THEN** the failure SHALL surface as a bounded transport-shape error
- **AND** it SHALL NOT be reported as a programming defect or silently replaced
  by a default value
