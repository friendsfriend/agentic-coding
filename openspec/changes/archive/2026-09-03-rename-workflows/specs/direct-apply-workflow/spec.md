## MODIFIED Requirements

### Requirement: Direct-apply workflow creation
The system SHALL support starting the pinned `openspec-apply` workflow definition at the implementation step after validating pre-authored OpenSpec proposal, design, tasks, and scenarios.

#### Scenario: CLI creates direct-apply workflow
- **GIVEN** pre-authored OpenSpec artifacts exist for change
- **WHEN** developer runs `agentic-coding workflow start --repo <repo> --change <change> --workflow openspec-apply ...`
- **THEN** engine SHALL validate artifacts and definition entry guards before creating workflow
- **AND** current step SHALL be implementation with no planning run
- **AND** implementation run SHALL use pinned routed profile

#### Scenario: Default workflow type preserves existing behavior
- **WHEN** developer starts workflow without `--workflow`
- **THEN** engine SHALL select pinned `openspec-full` definition
- **AND** initial run SHALL be planning rather than direct implementation

#### Scenario: Direct apply artifacts are invalid
- **WHEN** required artifact is missing, empty, malformed, has no scenario, or has no actionable task
- **THEN** start SHALL fail before workflow row, workspace, pane, or agent is created
- **AND** diagnostic SHALL identify invalid artifact

#### Scenario: Legacy workflow backward compatibility
- **WHEN** valid legacy direct-apply state is first accessed
- **THEN** the renamed implementation MAY reject the old technical ID rather than mapping it to `openspec-apply`
- **AND** ambiguous state SHALL become repair-required rather than guessed

### Requirement: Dashboard displays module-aware workflow
Dashboard SHALL display pinned `openspec-apply` definition, current step, resolved runtime profile, and available actions without assuming planner or phase list.

#### Scenario: Dashboard shows direct-apply detail
- **WHEN** `openspec-apply` workflow view is loaded during implementation
- **THEN** it SHALL identify definition `openspec-apply`
- **AND** it SHALL show implementation run and no planning run
- **AND** it SHALL render only actions returned by engine

### Requirement: Direct-apply archives before git operations
The `openspec-apply` definition SHALL sequence implementation, triage, verification/fix loop, developer review, OpenSpec archive, delivery, and completion with each successor selected by registered reducer.

#### Scenario: Direct-apply module order places archive before git-operations
- **WHEN** all required verifier runs complete without blocking critical findings
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
