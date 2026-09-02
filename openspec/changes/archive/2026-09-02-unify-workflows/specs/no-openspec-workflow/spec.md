## RENAMED Requirements

- FROM: `### Requirement: No-openspec skips archive step`
- TO: `### Requirement: No-openspec documents through wiki before delivery`

## MODIFIED Requirements

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
