## ADDED Requirements

### Requirement: Dashboard preserves the original workflow request

The workflow view and dashboard data projection SHALL carry the original user task from workflow metadata when one was supplied, so the dashboard can display the request without requiring a generated request artifact.

#### Scenario: Current workflow has a metadata task

- **WHEN** a workflow is started with a non-empty task and the dashboard loads its workflow view
- **THEN** the workflow view and dashboard state SHALL expose that task as the original request
- **AND** the dashboard SHALL use it for the Change panel request

#### Scenario: Workflow view has no metadata task

- **WHEN** a workflow has no metadata task
- **THEN** the optional request field SHALL remain absent or empty
- **AND** dashboard loading SHALL continue to the legacy request-artifact fallback

### Requirement: Change panel displays the user request

The agent dashboard's Change panel SHALL display the original user request in its REQUEST section whenever the workflow provides one.

#### Scenario: Request is available from current workflow state

- **WHEN** the dashboard renders a workflow whose original task is available in workflow metadata
- **THEN** the Change panel SHALL show that task under the REQUEST label
- **AND** it SHALL not replace the task with “Not created yet” merely because `request.md` is missing

#### Scenario: Legacy request artifact is available

- **WHEN** the workflow has no metadata task but has a readable legacy `request.md` artifact
- **THEN** the Change panel SHALL show the existing summary of that artifact under REQUEST

#### Scenario: No request source is available

- **WHEN** neither workflow metadata nor the legacy request artifact contains a request
- **THEN** the Change panel SHALL retain its explicit “Not created yet” empty-state text
