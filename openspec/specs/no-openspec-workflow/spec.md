# no-openspec-workflow Specification

## Purpose
TBD - created by archiving change introduce-no-openspec-workflow. Update Purpose after archive.

## Requirements

### Requirement: No-openspec workflow creation
The system SHALL support pinned `no-openspec` workflow definition starting at implementation from non-empty task without requiring or creating OpenSpec artifacts.

#### Scenario: CLI creates no-openspec workflow
- **GIVEN** clean Git repository and non-empty task
- **WHEN** developer runs `agentic-coding workflow start --repo <repo> --change <change> --workflow no-openspec --task <task> ...`
- **THEN** engine SHALL pin no-OpenSpec definition and routing
- **AND** current step SHALL be implementation with no planner or OpenSpec artifact gate
- **AND** implementation assignment SHALL include task directly

#### Scenario: Task is missing
- **WHEN** no-OpenSpec start receives empty task
- **THEN** start SHALL fail before workspace or workflow is created

#### Scenario: No-openspec worker starts without a request
- **WHEN** no-OpenSpec implementation run starts
- **THEN** assignment SHALL include task directly without requiring request file
- **AND** no planner SHALL launch

#### Scenario: No-openspec verification skips OpenSpec gates
- **WHEN** implementation completes
- **THEN** definition SHALL enter triage and verification without OpenSpec validator or OpenSpec verifier role
- **AND** other applicable verifier and test runs SHALL use common assignment/handoff protocol

#### Scenario: No-openspec transitions through full lifecycle
- **WHEN** implementation and verification complete and developer approves
- **THEN** workflow SHALL proceed implementation, triage, verification, developer-review, delivery, completed
- **AND** no planning or archive step SHALL run

### Requirement: Default workflow type preserves existing behavior
The system SHALL default start to pinned `standard` definition when no workflow definition is supplied.

#### Scenario: Default start is standard
- **WHEN** developer starts workflow without `--workflow`
- **THEN** engine SHALL validate standard definition and begin planning run
- **AND** it SHALL not infer workflow type from presence of modules or phases

#### Scenario: Legacy workflow backward compatibility
- **WHEN** valid legacy state has no workflow type or modules
- **THEN** migration SHALL map it to pinned standard definition only when phase/evidence are consistent
- **AND** otherwise expose repair-required state

### Requirement: Dashboard displays no-openspec workflow
Dashboard SHALL display pinned no-OpenSpec definition and engine-provided step/run/action view.

#### Scenario: Dashboard shows no-openspec detail
- **WHEN** no-OpenSpec workflow is in implementation
- **THEN** UI SHALL show worker run, configured runtime/profile, and no planner/OpenSpec tasks
- **AND** UI SHALL not infer type from module list

### Requirement: No-openspec workflow starts without an OpenSpec project
No-OpenSpec start SHALL allow repository without `openspec/config.yaml` while enforcing clean tree, branch, runtime, and workflow entry preconditions.

#### Scenario: No-openspec start skips OpenSpec project check
- **WHEN** valid no-OpenSpec start targets clean repository without OpenSpec config
- **THEN** workflow SHALL start implementation

#### Scenario: Standard and direct-apply still require OpenSpec
- **WHEN** standard or direct-apply start targets repository without OpenSpec config
- **THEN** start SHALL fail before creating workflow

#### Scenario: Dirty tree still blocks no-openspec start
- **WHEN** no-OpenSpec start targets dirty repository
- **THEN** start SHALL fail before creating branch, workspace, workflow, or agent

### Requirement: No-openspec worker guidance is self-consistent
No-OpenSpec implementation assignment SHALL contain task, focused validation policy, declared output, and generic handoff without OpenSpec task/checklist or skill references.

#### Scenario: No-openspec worker prompt names the verify command
- **WHEN** no-OpenSpec implementation run starts
- **THEN** message SHALL no longer name legacy verify command or instruct agent to read proposal/tasks
- **AND** completion SHALL use generic handoff declared by assignment

#### Scenario: Worker skill task tracking is conditional on tasks.md
- **WHEN** no-OpenSpec implementation assignment is rendered
- **THEN** no workflow skill SHALL load and no OpenSpec task tracking instruction SHALL appear
- **AND** output validation SHALL use no-OpenSpec step contract

### Requirement: No-openspec skips archive step
No-OpenSpec definition SHALL proceed from approved developer review directly to delivery because no OpenSpec change exists to archive.

#### Scenario: Developer approves no-OpenSpec review
- **WHEN** developer-review action approves verified no-OpenSpec change
- **THEN** definition SHALL enter delivery and enqueue commit/push effects
- **AND** no archive agent SHALL launch

#### Scenario: Delivery completes
- **WHEN** idempotent delivery confirms commit and push
- **THEN** workflow SHALL enter completed terminal step
