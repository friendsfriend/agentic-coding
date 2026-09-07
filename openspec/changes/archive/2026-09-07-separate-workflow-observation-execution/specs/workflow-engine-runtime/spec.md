## MODIFIED Requirements

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

## ADDED Requirements

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
