## ADDED Requirements

### Requirement: Shared workflow startup orchestration
CLI, dashboard, and internal workflow starts SHALL use one application-level startup operation for configuration resolution, registered role routing, preflight, Git preparation, and engine invocation. Entry points SHALL retain their input and presentation adapters while the engine retains final transactional authorization and invariant checks.

#### Scenario: Equivalent CLI and dashboard starts
- **WHEN** CLI and dashboard submit equivalent normalized startup requests for the same repository and configuration
- **THEN** both SHALL prepare equivalent definition selection, routing, execution settings, and Git metadata apart from generated identities and timestamps
- **AND** both SHALL reject the same invalid preconditions before launching agents

#### Scenario: Fusion preset supplies planner profiles
- **WHEN** a fusion startup selects a preset with two to five contiguous distinct planner profiles and supplies no explicit fusion-profile list
- **THEN** either entry point SHALL resolve that ordered planner set and the consolidator through the shared routing rules

#### Scenario: Explicit fusion profiles override a preset
- **WHEN** startup supplies a valid ordered explicit fusion-profile list as well as a preset
- **THEN** that list SHALL determine planner role assignments while remaining steps follow the existing preset precedence

#### Scenario: Invalid fusion routing is rejected
- **WHEN** the selected planner set has gaps, duplicates, an unknown profile, or fewer than two or more than five planners
- **THEN** startup SHALL fail before workflow creation or agent launch with an actionable routing diagnostic

#### Scenario: Direct engine caller bypasses preparation
- **WHEN** a direct engine call violates a start-time state or capability invariant
- **THEN** the engine SHALL still reject it without relying solely on application preflight
