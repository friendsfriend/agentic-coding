# workflow-engine-runtime Specification

## Purpose
TBD - created by archiving change consolidate-workflow-to-typescript. Update Purpose after archive.
## Requirements
### Requirement: TypeScript engine binary surface
The workflow engine SHALL be provided by `agentic-coding workflow` with developer/agent mutation surface limited to `start`, `action`, `handoff`, `question`, and `repair`, read-only `status`, `projects`, and `config`, separately named `agent-extension` management, and explicit repository-scoped `drain` maintenance execution. `start` SHALL accept a user-supplied workflow identifier (not a change identifier); the change identifier is chosen later by the planner. Running workflows SHALL be addressed by that workflow identifier. The `question` operation SHALL be available only to an authenticated managed agent and SHALL return the answer to its own pending question; developer responses SHALL use the existing revision-bound action channel.

#### Scenario: Engine verb runs through the binary
- **WHEN** `agentic-coding workflow status --repo <repo> --workflow-id <id>` is run for an existing workflow
- **THEN** it SHALL print a validated workflow view with revision, pinned definition, current step, active runs, routing, health, available actions, and pending/shared developer dialogue metadata
- **AND** it SHALL NOT expose a raw mutable persisted snapshot as the command contract or execute pending work

#### Scenario: Workflow starts with a workflow identifier
- **WHEN** `agentic-coding workflow start` is invoked with a user-supplied workflow identifier and no change identifier
- **THEN** the engine SHALL start the workflow keyed by that workflow identifier
- **AND** it SHALL NOT require or accept a change identifier at start

#### Scenario: Developer action executes
- **WHEN** a caller runs `agentic-coding workflow action <action-id> --repo <repo> --workflow-id <id> --revision <revision>`
- **THEN** the engine SHALL dispatch the engine-provided action through the unified command runtime
- **AND** an unknown, unavailable, or stale action SHALL fail without mutation

#### Scenario: Managed agent asks a question
- **WHEN** an active managed agent runs `agentic-coding workflow question` with its authenticated environment and bounded question input
- **THEN** the engine SHALL validate the run capability, record the question, and wait for the matching developer answer
- **AND** the command SHALL not accept workflow, role, successor, or recipient selection from the agent

#### Scenario: All verbs preserved
- **WHEN** a caller inspects the engine command surface
- **THEN** `start`, `status`, `action`, `handoff`, `question`, `repair`, `projects`, `config`, `agent-extension`, and `drain` SHALL exist with specified contracts
- **AND** removed legacy role/phase verbs SHALL not exist
- **AND** handoff and question SHALL not accept agent-selected phase, role, change ID, or successor step

#### Scenario: Explicit execution is requested
- **WHEN** an operator runs `agentic-coding workflow drain --repo <repo>`
- **THEN** a bounded execution pass SHALL process due effects and timer commands through the unified runtime
- **AND** its result SHALL identify pending/retry/failure conditions without requiring a status read to execute them

### Requirement: Engine module boundaries
The engine SHALL separate pure domain definitions/step behavior, transactional command application and persistence, external evidence collection and effect handlers, agent adapters, git/ssh, terminal layout, tracing/telemetry, and agent-extension management. Runtime persistence reducers SHALL own SQL application, while domain decisions SHALL consume explicit validated facts rather than invoke external I/O.

#### Scenario: Concerns are separated
- **WHEN** a developer inspects engine source
- **THEN** pure domain definitions and behavior SHALL not invoke SQLite, filesystem, Git, Herdr, network, clock, or agent runtime
- **AND** agent adapters SHALL not select a workflow successor or mutate workflow state directly
- **AND** no orchestration module SHALL bypass the unified command runtime

#### Scenario: Evidence is required for a decision
- **WHEN** a completion guard needs repository or artifact facts
- **THEN** an evidence boundary SHALL supply authenticated validated facts to the domain decision
- **AND** transaction-bound authorization and atomic persistence SHALL remain runtime-owned

### Requirement: Persisted state excludes terminal layout
Durable workflow snapshot SHALL contain workflow-meaningful state and run handles but SHALL NOT use pane/tab geometry or observed runtime status as lifecycle authority.

#### Scenario: Layout fields absent from saved state
- **WHEN** engine persists workflow
- **THEN** snapshot SHALL omit transient verification pane order and spare-pane geometry
- **AND** current step completion SHALL derive only from committed commands, not pane state

#### Scenario: Legacy state still loads
- **WHEN** recognized legacy state contains removed layout fields
- **THEN** migration SHALL ignore transient geometry while preserving validated workflow evidence
- **AND** resulting canonical snapshot SHALL omit those fields

#### Scenario: Runtime layout is reconstructed
- **WHEN** dashboard or adapter needs terminal layout
- **THEN** it SHALL query live Herdr state or non-authoritative runtime records
- **AND** missing pane SHALL not corrupt workflow snapshot

### Requirement: Plan approval review comments route to the planner
The plan approval gate SHALL accept a bounded `review-comments` developer action whose `comments` outcome returns the workflow to the planning step with the comments carried as planner step input, so the planner can adjust the plan against the feedback. The feedback loop SHALL be capped by the same retry bound as plan rejection.

#### Scenario: Comments outcome returns to planning with feedback
- **WHEN** the developer dispatches `review-comments` at the plan approval gate with a bounded comments payload
- **THEN** the workflow transitions to the planning step with the comments payload available as planner step input

#### Scenario: Bounded comment validation
- **WHEN** the developer dispatches `review-comments` with an empty, oversized, or malformed comments payload
- **THEN** the engine SHALL reject the action without mutating workflow state

#### Scenario: Approval still starts implementation
- **WHEN** the developer dispatches the plan approval action at the plan approval gate
- **THEN** the workflow transitions to the implementation step as before

#### Scenario: Feedback loop is capped
- **WHEN** the comments outcome repeats beyond the plan gate retry bound
- **THEN** the engine SHALL stop the loop and require operator attention

### Requirement: Shared workflow startup orchestration
CLI, dashboard, and internal workflow starts SHALL use one application-level startup operation for configuration resolution, registered role routing, preflight, Git preparation, and engine invocation. Entry points SHALL retain their input and presentation adapters while the engine retains final transactional authorization and invariant checks.

#### Scenario: Equivalent CLI and dashboard starts
- **WHEN** CLI and dashboard submit equivalent normalized startup requests for the same repository and configuration
- **THEN** both SHALL prepare equivalent definition selection, routing, execution settings, and Git metadata apart from generated identities and timestamps
- **AND** both SHALL reject the same invalid preconditions before launching agents

#### Scenario: Fusion preset supplies planner profiles
- **WHEN** a fusion startup selects a preset with two to five contiguous distinct planner profiles and supplies no explicit fusion-profile list
- **THEN** either entry point SHALL resolve that ordered planner set and the consolidator through the shared routing rules

#### Scenario: Explicit fusion profiles override a preset
- **WHEN** startup supplies a valid ordered explicit fusion-profile list as well as a preset
- **THEN** that list SHALL determine planner role assignments while remaining steps follow the existing preset precedence

#### Scenario: Invalid fusion routing is rejected
- **WHEN** the selected planner set has gaps, duplicates, an unknown profile, or fewer than two or more than five planners
- **THEN** startup SHALL fail before workflow creation or agent launch with an actionable routing diagnostic

#### Scenario: Direct engine caller bypasses preparation
- **WHEN** a direct engine call violates a start-time state or capability invariant
- **THEN** the engine SHALL still reject it without relying solely on application preflight

### Requirement: Execution continues independently of observation
Committed effects and timer-based commands SHALL be scheduled by explicit mutation continuation, startup/resume recovery, or a lifecycle-owned execution coordinator. Observation APIs SHALL not be responsible for execution progress.

#### Scenario: Retry becomes due without refresh
- **WHEN** a retry becomes due while a scheduled continuation is active and no status or dashboard refresh occurs
- **THEN** continuation SHALL attempt permitted recovery according to the durable lease/retry policy

#### Scenario: Question expires without status polling
- **WHEN** a pending question reaches its deadline while an execution coordinator or waiting question command is active
- **THEN** expiry SHALL be submitted as an explicit authorized command
- **AND** observing the question's elapsed deadline SHALL not itself persist a revision

#### Scenario: Execution is interrupted
- **WHEN** a continuation exits before pending work completes
- **THEN** durable pending/retry state SHALL remain visible
- **AND** explicit drain or startup/resume recovery SHALL be able to continue it without relying on status side effects

### Requirement: Effect-native workflow application operations
Workflow initialization, start, dispatch, read projections, repair/migration previews, capability operations, and effect ownership operations SHALL expose Effect programs with typed expected failures and explicit concrete service requirements. Production and test dependencies SHALL be provided at application composition boundaries, not constructed within domain decisions.

#### Scenario: Caller composes startup and dispatch
- **WHEN** an application caller composes workflow operations
- **THEN** it SHALL compose Effect values without running nested runtimes inside engine services
- **AND** external execution SHALL occur only when an authorized composition boundary runs the program

#### Scenario: Test supplies dependencies
- **WHEN** a focused workflow test provides a temporary store, controlled clock, and fake external services
- **THEN** the same application program SHALL run without consulting hidden production dependencies

### Requirement: Pure workflow decisions remain independent of Effect execution
Definitions, registered step decisions, routing transforms, and read projections SHALL remain deterministic functions of supplied data. They SHALL not acquire Effect services, start fibers, perform I/O, or run an Effect runtime. Expected domain rejections SHALL be translated into the application error channel at an explicit boundary.

#### Scenario: Step completion is evaluated
- **WHEN** a registered step processes validated completion evidence
- **THEN** it SHALL return its pure decision without persistence or service access
- **AND** the engine SHALL retain final authorization and atomic application authority

### Requirement: Effect startup preserves shared configuration semantics
CLI and dashboard startup SHALL use the same Effect application preparation operation and decoded configuration services. Repository/worktree selection, repository-independent behavior, profile precedence, preflight checks, and non-secret execution setting pins SHALL retain their established semantics.

#### Scenario: Equivalent startup requests use different entry points
- **WHEN** CLI and dashboard prepare equivalent requests with the same service inputs
- **THEN** their routing, configuration provenance, and pinned delivery settings SHALL be equivalent apart from generated identities and timestamps
- **AND** neither application service SHALL import CLI or TUI presentation orchestration

### Requirement: Workflow application runtimes have explicit lifecycle owners
CLI commands and dashboard integration SHALL execute workflow Effect programs through named application composition roots. CLI invocation SHALL own its bounded runtime lifetime; dashboard SHALL reuse one application runtime with owned repository scopes. Internal services SHALL not execute nested runtimes or instantiate alternative production orchestration paths.

#### Scenario: Dashboard refresh repeats
- **WHEN** the dashboard refreshes a workflow repeatedly
- **THEN** it SHALL reuse its application runtime and existing execution ownership rather than create new runtimes or drainers per read

#### Scenario: Application shuts down
- **WHEN** CLI or dashboard receives controlled shutdown
- **THEN** it SHALL interrupt owned temporary work and finalize/export within documented bounds
- **AND** it SHALL not stop durable agents/workspaces merely because their creating execution scope ended

### Requirement: Effect integration preserves explicit execution and external contracts
Final Effect callers SHALL retain established CLI/JSON behavior, read-only observation, explicit drain/continuation scheduling, revision-bound actions, and durable recovery. Runtime cancellation or telemetry failure SHALL not automatically replay a committed mutation. Workflow telemetry SHALL preserve existing envelope and trace correlation with bounded redacted export.

#### Scenario: CLI exits after a command commits
- **WHEN** a committed command leaves pending work and its initiating CLI exits
- **THEN** explicit continuation or later startup/resume SHALL recover that work without requiring a status read to execute effects

#### Scenario: Telemetry export fails
- **WHEN** export fails after command commit
- **THEN** the committed workflow result SHALL remain authoritative and SHALL not be rolled back or replayed
- **AND** export cleanup SHALL not keep application shutdown alive beyond its budget

### Requirement: Full workflow migration has no legacy orchestration path
Every inventoried workflow application/I/O caller SHALL use the Effect application model at completion. Pure functions, named native/foreign API adapters, and outer framework bridges SHALL remain explicit valid boundaries. Migration-only facades and replaced implementations SHALL be removed. Existing source architecture checks SHALL guard runtime owners, native boundaries, obsolete imports, and application/presentation dependency direction.

#### Scenario: Legacy caller remains at cutover
- **WHEN** the final inventory or architecture check finds a caller using a migration-only engine or handler facade
- **THEN** cutover verification SHALL fail and identify the caller and required application boundary

#### Scenario: Service runs a nested runtime
- **WHEN** a guarded workflow service invokes a recognized runtime execution API outside an allowed composition root
- **THEN** the architecture check SHALL fail with the offending source location

#### Scenario: Pure helper remains plain TypeScript
- **WHEN** a deterministic helper uses supplied values without I/O, service acquisition, or runtime execution
- **THEN** migration coverage SHALL accept it as a documented pure boundary rather than require an Effect wrapper

