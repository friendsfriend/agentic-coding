## ADDED Requirements

### Requirement: Manual workflow phase override
The system SHALL let developer overwrite an active managed workflow phase through dashboard or `herdr-workflow override-phase` without using normal transition graph.

#### Scenario: Developer confirms dashboard override
- **GIVEN** dashboard displays active workflow in any operational phase
- **WHEN** developer selects a different operational phase and confirms overwrite
- **THEN** dashboard SHALL invoke workflow override command
- **AND** dashboard SHALL refresh displayed workflow state after command completes
- **AND** override SHALL NOT start, stop, or message an agent

#### Scenario: CLI overrides phase
- **GIVEN** managed workflow state exists
- **WHEN** developer runs `herdr-workflow override-phase` with an operational target phase
- **THEN** system SHALL persist target phase and a new phase-start timestamp through normal state persistence locations
- **AND** preserve all other workflow state fields
- **AND** record telemetry containing source and target phase

#### Scenario: Invalid override target
- **WHEN** developer requests an unknown phase or `closed` through phase override
- **THEN** system SHALL reject request before mutating workflow state
- **AND** `closed` lifecycle SHALL remain owned by normal close command

### Requirement: Run-bound recovery plan artifact
The system SHALL consume recovery action only from current recovery run's validated plan artifact.

#### Scenario: Recovery agent creates plan
- **WHEN** recovery starts
- **THEN** system SHALL create recovery context containing fresh recovery identifier and exact plan artifact path
- **AND** recovery instructions SHALL require agent to write JSON plan to that path rather than output plan JSON in chat
- **AND** prior recovery plan artifact SHALL not be considered current

#### Scenario: Dashboard displays current recovery plan
- **WHEN** dashboard loads recovery plan
- **THEN** it SHALL present only a plan whose recovery identifier matches current workflow recovery identifier
- **AND** malformed or stale plan SHALL not be offered for application

#### Scenario: Recovery action is applied
- **WHEN** developer confirms recovery plan application
- **THEN** controller SHALL validate plan identifier, allowlisted action shape, verifier role when required, and compatibility with current workflow phase before dispatch
- **AND** invalid, stale, or incompatible plan SHALL fail without changing workflow state
- **AND** valid plan SHALL retain explicit dashboard confirmation before executing existing recovery handler
