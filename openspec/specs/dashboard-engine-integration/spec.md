# dashboard-engine-integration Specification

## Purpose
TBD - created by archiving change dashboard-in-process-engine. Update Purpose after archive.
## Requirements
### Requirement: In-process engine use
The dashboard SHALL invoke the workflow engine in-process rather than spawning `herdr-workflow` and reparsing its JSON output.

#### Scenario: Workflow action runs in-process
- **WHEN** the dashboard triggers a workflow action (e.g. approve apply, verify, finish-review)
- **THEN** it SHALL call the engine module directly
- **AND** it SHALL NOT spawn a `herdr-workflow` subprocess for that action

#### Scenario: Agent shim unaffected
- **WHEN** an agent runs `herdr-workflow verify …`
- **THEN** the shim SHALL still work; only the dashboard's own calls move in-process

### Requirement: Single shared Herdr client
There SHALL be one Herdr client module that parses the `.result` envelope and provides pane-geometry helpers, consumed by both the engine and the dashboard.

#### Scenario: One envelope parser
- **WHEN** a developer inspects Herdr access across the codebase
- **THEN** the `.result` envelope SHALL be parsed in exactly one module
- **AND** pane-geometry/direction math SHALL be defined once and reused (not duplicated between engine launch logic and dashboard focus logic)

### Requirement: Event-driven refresh
The dashboard SHALL refresh from workflow events instead of a fixed-interval re-spawn poll.

#### Scenario: Refresh reacts to workflow output
- **WHEN** the engine appends to `telemetry.jsonl` / `traces.jsonl` or updates workflow state
- **THEN** the dashboard SHALL refresh in response to that change
- **AND** it SHALL NOT re-spawn `herdr agent list`, `herdr workspace list`, and `git` on a fixed 5-second cycle as the sole refresh mechanism
- **AND** a low-frequency safety re-sync MAY remain

