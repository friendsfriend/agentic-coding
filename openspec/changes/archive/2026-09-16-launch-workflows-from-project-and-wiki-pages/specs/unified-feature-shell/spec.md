## MODIFIED Requirements

### Requirement: One feature-preserving terminal shell
The full application SHALL render Home with exactly Environments, Observability, Wiki and Settings under one OpenTUI renderer with shared page-based chrome. Environment categories, providers/issues/change requests/CI, agent utilities, wiki browsing/reviews and telemetry detail capabilities SHALL remain reachable. Workflow creation SHALL be contextual to application/library or independent Wiki pages; persistent model configuration SHALL live in Settings. Workflow execution reviews and questions SHALL remain in the Herdr-managed dashboard. No global or project-local workflow browser, history/reopen route or active-workflow dashboard launcher SHALL remain.

#### Scenario: User starts repository work
- **WHEN** a user opens an application and starts a workflow
- **THEN** existing Herdr orchestration SHALL own its workflow workspace/dashboard and the full application SHALL retain the application page
- **AND** Settings and telemetry SHALL remain reachable through the page hierarchy

### Requirement: Services outlive feature visibility
Workflow execution coordinators, telemetry listeners/watchers and database lifetimes SHALL be owned by the application root independently of feature visibility. Feature rendering SHALL NOT create additional execution coordinators or claim durable effects.

#### Scenario: Navigate while workflow executes
- **WHEN** the user changes full-application pages while an execution pass is active
- **THEN** execution and lease renewal SHALL continue under the same root owner
- **AND** an explicitly launched Herdr dashboard SHALL subscribe to authoritative state without duplicating execution

#### Scenario: External tool temporarily owns terminal
- **WHEN** the renderer is suspended while a foreground terminal utility runs
- **THEN** asynchronous child waiting SHALL allow workflow lease renewal and telemetry processing to continue
- **AND** renderer/input ownership SHALL be restored on success, failure or cancellation

#### Scenario: Dispose application
- **WHEN** the application owner is disposed
- **THEN** owned services SHALL be cancelled/finalized once without disposing another application's resources
