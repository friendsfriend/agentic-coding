# Spec Delta

## REMOVED Requirements

### Requirement: Shared workflow startup orchestration

**Reason**: Redefined so the shared startup operation validates per-step model-pool coverage and no longer accepts an explicit fusion-profile override; the planner roster is classified by route-plan with the `fusion.plan` tagged defaults as the start-time seed.

**Migration**: Callers that passed an explicit fusion-profile list must remove the option and configure the `fusion.plan` pool instead; all other startup inputs keep their semantics.

## ADDED Requirements

### Requirement: Shared workflow startup orchestration with classifier pools

CLI, dashboard, and internal workflow starts SHALL use one application-level startup operation for configuration resolution, registered role routing, pool coverage validation, preflight, Git preparation, and engine invocation. Entry points SHALL retain their input and presentation adapters while the engine retains final transactional authorization and invariant checks. Startup SHALL NOT accept a workflow-level explicit planner-profile override.

#### Scenario: Equivalent CLI and dashboard starts
- **WHEN** CLI and dashboard submit equivalent normalized startup requests for the same repository and configuration
- **THEN** both SHALL prepare equivalent definition selection, routing, execution settings, and Git metadata apart from generated identities and timestamps
- **AND** both SHALL reject the same invalid preconditions before launching agents

#### Scenario: Fusion preset supplies planner profiles
- **WHEN** a fusion startup selects a preset whose `fusion.plan` pool declares between two and five distinct tagged default profiles
- **THEN** either entry point SHALL seed the ordered planner roles from those tagged defaults and resolve the consolidator through the shared routing rules
- **AND** the classification pass SHALL replace the seeded planner routing with the classified roster before the fan-out launches

#### Scenario: Missing pool coverage is rejected
- **WHEN** the resolved definition contains a classifiable step whose selected preset has no valid pool
- **THEN** startup SHALL fail before workflow creation or agent launch with a diagnostic pointing at Settings → Presets

#### Scenario: Invalid fusion routing is rejected
- **WHEN** the `fusion.plan` tagged defaults have gaps, duplicates, an unknown profile, or fewer than two or more than five entries
- **THEN** startup SHALL fail before workflow creation or agent launch with an actionable routing diagnostic

#### Scenario: Direct engine caller bypasses preparation
- **WHEN** a direct engine call violates a start-time state or capability invariant
- **THEN** the engine SHALL still reject it without relying solely on application preflight
