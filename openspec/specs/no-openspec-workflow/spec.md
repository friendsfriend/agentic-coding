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
- **THEN** workflow SHALL proceed implementation, triage, verification, developer-review, wiki, wiki-approval, delivery, completed
- **AND** no planning or archive step SHALL run

### Requirement: Default workflow type preserves existing behavior
The system SHALL default start to the pinned `openspec-full` definition when no workflow definition is supplied.

#### Scenario: Default start is standard
- **WHEN** developer starts workflow without `--workflow`
- **THEN** engine SHALL validate the `openspec-full` definition and begin planning run
- **AND** it SHALL not infer workflow type from presence of modules or phases

#### Scenario: Legacy workflow backward compatibility
- **WHEN** valid legacy state has no workflow type or modules
- **THEN** migration SHALL map it to the pinned `openspec-full` definition only when phase/evidence are consistent
- **AND** otherwise expose repair-required state

### Requirement: Dashboard displays no-openspec workflow
Dashboard SHALL display pinned no-OpenSpec definition and engine-provided step/run/action view, using the `No OpenSpec` UI label and its workflow description.

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

### Requirement: No-openspec documents through wiki before delivery
No-OpenSpec definition SHALL proceed from approved developer review through the wiki documentation step and wiki approval gate before delivery, and SHALL NOT include an OpenSpec archive step because no OpenSpec change exists to archive. The wiki approval `approve` outcome SHALL enqueue the engine-owned wiki human-verification effect when concepts were touched and advance to delivery; the `comments` outcome SHALL return the workflow to the wiki documentation step under a bounded loop. These wiki steps apply to the wiki-gated definition versions; legacy non-gated definition versions SHALL retain the prior archive-free, wiki-free path directly from developer review to delivery.

#### Scenario: Developer approves no-OpenSpec review
- **WHEN** developer-review action approves verified no-OpenSpec change under a wiki-gated definition version
- **THEN** definition SHALL enter the wiki documentation step rather than delivery
- **AND** no archive agent SHALL launch

#### Scenario: Wiki approval advances to delivery
- **WHEN** the developer approves at the no-OpenSpec wiki approval gate
- **THEN** the engine SHALL promote touched concepts through the wiki human-verification effect and enter delivery to enqueue commit/push effects
- **AND** no archive step SHALL run

#### Scenario: Wiki comments return to documentation
- **WHEN** the developer submits comments at the no-OpenSpec wiki approval gate
- **THEN** the workflow SHALL return to the wiki documentation step under its bounded loop

#### Scenario: Delivery completes
- **WHEN** idempotent delivery confirms commit and push
- **THEN** workflow SHALL enter completed terminal step

### Requirement: New-workflow catalog describes no-openspec
The new-workflow modal SHALL retain `quick` as the selectable alias that starts the `no-openspec` definition and SHALL show the `No OpenSpec` label plus a description explaining that it supports repositories without OpenSpec and its apply, review, developer-review, wiki, and wiki-review phases.

#### Scenario: Quick alias starts no-openspec
- **WHEN** a user selects the quick/no-OpenSpec workflow and submits the wizard
- **THEN** dashboard startup SHALL pass `no-openspec` to the workflow engine
- **AND** the modal SHALL not display any parenthesized text in labels, options, or workflow display values
