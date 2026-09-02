## MODIFIED Requirements

### Requirement: Single canonical workflow store
The system SHALL use one canonical repository SQLite store for workflow authority and SHALL resolve same store from main checkout or linked worktree. Each workflow row SHALL be keyed by the user-supplied workflow identifier; the change identifier SHALL be recorded during the plan step from the planner-declared primary change rather than required at workflow start.

#### Scenario: Command runs from linked worktree
- **WHEN** command is invoked inside workflow worktree
- **THEN** engine SHALL resolve repository's canonical store
- **AND** it SHALL read and write same row used by dashboard in main repository

#### Scenario: Workflow is persisted
- **WHEN** snapshot changes
- **THEN** engine SHALL write only canonical store
- **AND** it SHALL NOT maintain writable state mirrors in worktree

#### Scenario: Workflow row is keyed by workflow identifier
- **WHEN** a workflow is started with a user-supplied workflow identifier
- **THEN** the canonical store row SHALL be keyed by that workflow identifier
- **AND** the stored change identifier SHALL be empty until the plan step records the planner-declared primary change

### Requirement: Run-bound artifact validation
Agent-produced output SHALL be accepted only from declared output path for active run and after size, schema, run identity, and content digest validation. Plan-step completion SHALL additionally validate that the planner-declared primary change directory exists and is complete before recording it as the workflow's change identifier.

#### Scenario: Valid output artifact is submitted
- **WHEN** active run submits declared artifact satisfying pinned output contract
- **THEN** engine SHALL store artifact digest with completion event
- **AND** reducer SHALL receive validated parsed output

#### Scenario: Artifact is stale or outside assignment
- **WHEN** handoff references another run's artifact, path outside assigned workflow area, oversized content, or schema mismatch
- **THEN** handoff SHALL fail without consuming run capability
- **AND** engine SHALL NOT infer outcome from file existence alone

#### Scenario: Plan declares primary change
- **WHEN** the plan step completes and declares a primary change identifier
- **THEN** the engine SHALL validate that the named primary change directory exists and is complete
- **AND** it SHALL reject the completion when the primary change is missing, incomplete, or undeclared
