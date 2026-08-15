## MODIFIED Requirements

### Requirement: Direct-apply workflow creation
The system SHALL support starting pinned `direct-apply` workflow definition at implementation step after validating pre-authored OpenSpec proposal, design, tasks, and scenarios.

#### Scenario: CLI creates direct-apply workflow
- **GIVEN** pre-authored OpenSpec artifacts exist for change
- **WHEN** developer runs `agentic-coding workflow start --repo <repo> --change <change> --workflow direct-apply ...`
- **THEN** engine SHALL validate artifacts and definition entry guards before creating workflow
- **AND** current step SHALL be implementation with no planning run
- **AND** implementation run SHALL use pinned routed profile

#### Scenario: Default workflow type preserves existing behavior
- **WHEN** developer starts workflow without `--workflow`
- **THEN** engine SHALL select pinned standard definition
- **AND** initial run SHALL be planning rather than direct implementation

#### Scenario: Direct apply artifacts are invalid
- **WHEN** required artifact is missing, empty, malformed, has no scenario, or has no actionable task
- **THEN** start SHALL fail before workflow row, workspace, pane, or agent is created
- **AND** diagnostic SHALL identify invalid artifact

#### Scenario: Legacy workflow backward compatibility
- **WHEN** valid legacy direct-apply state is first accessed
- **THEN** engine SHALL map it to pinned direct-apply definition and valid step/run state
- **AND** ambiguous state SHALL become repair-required rather than guessed

### Requirement: Dashboard displays module-aware workflow
Dashboard SHALL display pinned direct-apply definition, current step, resolved runtime profile, and available actions without assuming planner or phase list.

#### Scenario: Dashboard shows direct-apply detail
- **WHEN** direct-apply workflow view is loaded during implementation
- **THEN** it SHALL identify definition `direct-apply`
- **AND** it SHALL show implementation run and no planning run
- **AND** it SHALL render only actions returned by engine

### Requirement: Direct-apply archives before git operations
Direct-apply definition SHALL sequence implementation, triage, verification/fix loop, developer review, OpenSpec archive, delivery, and completion with each successor selected by registered reducer.

#### Scenario: Direct-apply module order places archive before git-operations
- **WHEN** all required verifier runs complete without blocking critical findings
- **THEN** engine SHALL enter developer-review gate
- **AND** approval action SHALL enter archive before delivery

#### Scenario: Archive move is staged into the pushed commit
- **WHEN** archive run submits valid completion after OpenSpec archive validation
- **THEN** engine SHALL enter delivery step and enqueue idempotent commit/push effects including archive move
- **AND** workflow SHALL complete only after delivery confirms pushed archived tree

#### Scenario: Direct-apply phase flow after developer approval
- **WHEN** developer approves verified direct-apply workflow
- **THEN** registered flow SHALL proceed archive, delivery, then completed
- **AND** delivery SHALL not run before archive completes

#### Scenario: Verification fails
- **WHEN** verifier output contains critical finding
- **THEN** definition SHALL return to implementation fix run with validated findings input
- **AND** next verification attempt SHALL use same pinned routing unless repaired

## REMOVED Requirements

### Requirement: Apply-verify module internal lifecycle
**Reason**: Flat phase/module lifecycle is replaced by registered implementation, triage, verification, and fix steps with run contracts.
**Migration**: Legacy phases map to corresponding pinned steps during migration.

### Requirement: Module gate transitions
**Reason**: Gates are registered developer-actor steps and engine-provided actions, not special module boundaries.
**Migration**: Dashboard submits returned action with revision.

### Requirement: Module registry orders archive before git-operations
**Reason**: Explicit workflow graph and delivery effects replace positional module table.
**Migration**: Direct-apply definition explicitly links archive completion to delivery.
