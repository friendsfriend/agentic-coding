# workflow-engine-runtime Specification

## Purpose
TBD - created by archiving change consolidate-workflow-to-typescript. Update Purpose after archive.
## Requirements
### Requirement: TypeScript engine binary surface
The workflow engine SHALL be provided by the `agentic-coding` binary as `agentic-coding workflow <verb>`, and the Python engine SHALL be retired.

#### Scenario: Engine verb runs through the binary
- **WHEN** `agentic-coding workflow status --repo <repo> --change <id>` is run for an existing workflow
- **THEN** it SHALL print the same state JSON the Python `herdr-workflow status` produced
- **AND** the Python `pi/lib/herdr_workflow/` package and `pi/bin/herdr-workflow` entrypoint SHALL no longer be present

#### Scenario: All verbs preserved
- **WHEN** a caller invokes any of `start`, `planner`, `apply`, `verify`, `dispatch-verifiers`, `verification-result`, `finish-review`, `archive`, `close`, `phase`, `override-phase`, `preflight-archive`, `set-return`, `message`, `status`, `projects`, `config`, or `plugin`
- **THEN** the verb SHALL exist with the same flags and stdout contract as the Python engine

### Requirement: Agent CLI compatibility shim
A `herdr-workflow` executable SHALL forward its arguments to `agentic-coding workflow` so agent skills, prompts, and the `PLAN_REJECTED` loop keep working unchanged.

#### Scenario: Agent invocation still works
- **WHEN** an agent runs `herdr-workflow verify --repo . --change <id>`
- **THEN** the shim SHALL execute `agentic-coding workflow verify --repo . --change <id>`
- **AND** the exit code and stdout SHALL match the engine's direct output

#### Scenario: Proposed transition loop unchanged
- **WHEN** a planner runs `herdr-workflow phase --repo . --change <id> proposed` and the plan quality gate fails
- **THEN** the shim SHALL surface the same `PLAN_REJECTED` message the engine emits

### Requirement: Engine module boundaries
The ported engine SHALL separate orchestration, git/ssh, terminal layout, tracing/telemetry, and plugin management so that no single module spans all of these concerns.

#### Scenario: Concerns are separated
- **WHEN** a developer inspects the engine source
- **THEN** phase orchestration, git/ssh helpers, Herdr terminal layout, tracing/telemetry, and plugins SHALL each live in their own module
- **AND** no module SHALL contain all five concerns (as the former `commands.py` did)

### Requirement: Persisted state excludes terminal layout
Durable workflow state SHALL NOT contain terminal-layout fields; pane layout SHALL be reconstructed from live Herdr queries or a non-durable store.

#### Scenario: Layout fields absent from saved state
- **WHEN** the engine saves `state.json` at any phase
- **THEN** the file SHALL NOT contain `verificationSecondRowPane`, `verificationSecondRowRole`, or `verificationPaneOrder`

#### Scenario: Legacy state still loads
- **WHEN** the engine loads an existing `state.json` that contains those layout fields
- **THEN** it SHALL load without error, ignoring the removed fields

### Requirement: Behavioral parity gate
The ported engine SHALL preserve the observable behavior of the Python engine for every verb and phase transition, validated by the ported test suite.

#### Scenario: Parity suite passes
- **WHEN** the ported `bun test` suite (including the characterization test) runs
- **THEN** verb stdout and `state.json` semantics SHALL match the Python engine's behavior for every covered case

