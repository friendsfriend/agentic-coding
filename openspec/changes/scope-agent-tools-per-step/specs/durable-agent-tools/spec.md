## ADDED Requirements

### Requirement: Workflow runs install only their step's tool groups

A durable workflow run SHALL install only the tool groups its step declares for the run's role, and a step that declares none SHALL receive every group. Coding tools, the read-only policy and the handoff path SHALL be unaffected.

#### Scenario: Planner run
- **WHEN** a `core.plan` run starts
- **THEN** its offered tools SHALL NOT include `stage_*`, `browser_*`, `db_query` or `otel_query`

#### Scenario: Undeclared step
- **WHEN** a run starts for a step whose behavior declares no tool groups
- **THEN** it SHALL be offered every workflow tool group
