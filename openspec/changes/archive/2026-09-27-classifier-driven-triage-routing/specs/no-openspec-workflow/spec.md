# Spec Delta

## MODIFIED Requirements

### Requirement: No-openspec workflow creation
The system SHALL support pinned `no-openspec` workflow definition starting at implementation from non-empty task without requiring or creating OpenSpec artifacts. The per-round verifier role selection of that definition SHALL NOT ask about the OpenSpec verifier role, and its implementation loop SHALL still route through the role-selection step before triage.

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
- **THEN** definition SHALL enter the per-round verifier role selection step, then triage and verification, without OpenSpec validator or OpenSpec verifier role
- **AND** the role-selection step SHALL NOT ask any question about the OpenSpec verifier role
- **AND** other applicable verifier and test runs SHALL use common assignment/handoff protocol

#### Scenario: No-openspec transitions through full lifecycle
- **WHEN** implementation and verification complete and developer approves
- **THEN** workflow SHALL proceed implementation, verifier role selection, triage, verification, developer-review, wiki, wiki-approval, delivery, completed
- **AND** no planning or archive step SHALL run
