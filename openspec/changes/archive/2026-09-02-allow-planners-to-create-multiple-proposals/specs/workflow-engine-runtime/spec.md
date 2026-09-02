## MODIFIED Requirements

### Requirement: TypeScript engine binary surface
The workflow engine SHALL be provided by `agentic-coding workflow` with mutation surface limited to `start`, `action`, `handoff`, `question`, and `repair`, read-only `status`, `projects`, and `config`, and separately named `agent-extension` management. `start` SHALL accept a user-supplied workflow identifier (not a change identifier); the change identifier is chosen later by the planner. Running workflows SHALL be addressed by that workflow identifier. The `question` operation SHALL be available only to an authenticated managed agent and SHALL return the answer to its own pending question; developer responses SHALL use the existing revision-bound action channel.

#### Scenario: Engine verb runs through the binary
- **WHEN** `agentic-coding workflow status --repo <repo> --workflow-id <id>` is run for an existing workflow
- **THEN** it SHALL print validated workflow view with revision, pinned definition, current step, active runs, routing, health, available actions, and pending/shared developer dialogue metadata
- **AND** it SHALL NOT expose raw mutable persisted snapshot as command contract

#### Scenario: Workflow starts with a workflow identifier
- **WHEN** `agentic-coding workflow start` is invoked with a user-supplied workflow identifier and no change identifier
- **THEN** the engine SHALL start the workflow keyed by that workflow identifier
- **AND** it SHALL NOT require or accept a change identifier at start

#### Scenario: Developer action executes
- **WHEN** caller runs `agentic-coding workflow action <action-id> --repo <repo> --workflow-id <id> --revision <revision>`
- **THEN** engine SHALL dispatch engine-provided action through unified command runtime
- **AND** unknown, unavailable, or stale action SHALL fail without mutation

#### Scenario: Managed agent asks a question
- **WHEN** an active managed agent runs `agentic-coding workflow question` with its authenticated environment and bounded question input
- **THEN** the engine SHALL validate the run capability, record the question, and wait for the matching developer answer
- **AND** the command SHALL not accept workflow, role, successor, or recipient selection from the agent

#### Scenario: All verbs preserved
- **WHEN** caller inspects engine command surface
- **THEN** `start`, `status`, `action`, `handoff`, `question`, `repair`, `projects`, `config`, and `agent-extension` SHALL exist with specified contracts
- **AND** removed legacy role/phase verbs SHALL not exist
- **AND** handoff and question SHALL not accept agent-selected phase, role, change ID, or successor step
