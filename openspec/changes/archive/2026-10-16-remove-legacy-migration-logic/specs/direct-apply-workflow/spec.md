## MODIFIED Requirements

### Requirement: Direct-apply workflow creation
The system SHALL support starting the pinned `openspec-apply` workflow definition at the `core.route-apply` classification step after validating pre-authored OpenSpec proposal, design, tasks, and scenarios. Classification SHALL resolve the apply-phase pools before the implementation step launches. Historical workflow state SHALL NOT be translated into the direct-apply definition.

#### Scenario: CLI creates direct-apply workflow
- **GIVEN** pre-authored OpenSpec artifacts exist for a change
- **WHEN** a developer runs `agentic-coding workflow start --repo <repo> --change <change> --workflow openspec-apply ...`
- **THEN** the engine SHALL validate artifacts and definition entry guards before creating the workflow
- **AND** the current step SHALL be `core.route-apply` with no planning run
- **AND** after classification the implementation run SHALL use the routed pool profile

#### Scenario: Default workflow type preserves existing behavior
- **WHEN** a developer starts a workflow without `--workflow`
- **THEN** the engine SHALL select the pinned `openspec` definition
- **AND** the initial run SHALL be planning rather than direct implementation

#### Scenario: Direct apply artifacts are invalid
- **WHEN** a required artifact is missing, empty, malformed, has no scenario, or has no actionable task
- **THEN** start SHALL fail before a workflow row, workspace, pane, or agent is created
- **AND** the diagnostic SHALL identify the invalid artifact

#### Scenario: Historical workflow identifiers are not translated
- **WHEN** a current build encounters an old direct-apply workflow identifier or state shape
- **THEN** it SHALL refuse the unsupported format without translating or repairing it
