# direct-apply-workflow Specification

## Purpose
TBD - created by archiving change introduce-other-workflows. Update Purpose after archive.
## Requirements
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

### Requirement: Dashboard displays module-aware workflow
Dashboard SHALL display pinned `openspec-apply` definition, current step, resolved runtime profile, and available actions without assuming planner or phase list.

#### Scenario: Dashboard shows direct-apply detail
- **WHEN** `openspec-apply` workflow view is loaded during implementation
- **THEN** it SHALL identify definition `openspec-apply`
- **AND** it SHALL show implementation run and no planning run
- **AND** it SHALL render only actions returned by engine

### Requirement: Direct-apply archives before git operations

The `openspec-apply` definition SHALL sequence classification, implementation, triage, verification/fix loop, developer review, OpenSpec archive, delivery, and completion with each successor selected by registered reducer.

#### Scenario: Direct-apply module order places archive before git-operations
- **WHEN** classification completes and all required verifier runs complete without blocking critical findings
- **THEN** engine SHALL enter developer-review gate
- **AND** approval action SHALL enter archive before delivery

#### Scenario: Archive move is staged into the pushed commit
- **WHEN** archive run submits valid completion after OpenSpec archive validation
- **THEN** engine SHALL enter delivery step and enqueue idempotent commit/push effects including archive move
- **AND** workflow SHALL complete only after delivery confirms pushed archived tree

#### Scenario: Direct-apply phase flow after developer approval
- **WHEN** developer approves verified `openspec-apply` workflow
- **THEN** registered flow SHALL proceed archive, delivery, then completed
- **AND** delivery SHALL not run before archive completes

#### Scenario: Verification fails
- **WHEN** verifier output contains critical finding
- **THEN** definition SHALL return to implementation fix run with validated findings input
- **AND** next verification attempt SHALL use same pinned routing unless repaired

