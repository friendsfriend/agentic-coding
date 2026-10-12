## MODIFIED Requirements

### Requirement: Shared workflow startup orchestration with classifier pools

CLI, dashboard, and internal workflow starts SHALL use one application-level startup operation for configuration resolution, registered role routing, per-step model resolution and preflight, Git preparation, and engine invocation. Entry points SHALL retain their input and presentation adapters while the engine retains final transactional authorization and invariant checks. Startup SHALL accept the per-step model selection a caller supplies (spec: `orchestrator-step-model-selection`) and SHALL NOT otherwise accept a workflow-level explicit planner-profile override. Startup SHALL NOT require a selected preset and SHALL NOT validate pool coverage: a step whose preset declares no pool SHALL resolve through the configured routes, definition defaults, and the built-in model-agnostic profile.

#### Scenario: Equivalent CLI and dashboard starts

- **WHEN** CLI and dashboard submit equivalent normalized startup requests for the same repository and configuration
- **THEN** both SHALL prepare equivalent definition selection, routing, execution settings, and Git metadata apart from generated identities and timestamps
- **AND** both SHALL reject the same invalid preconditions before launching agents

#### Scenario: Fusion roster comes from the selection or the preset

- **WHEN** a fusion workflow starts, naming a roster or selecting a preset whose `fusion.plan` pool declares between two and five distinct profiles
- **THEN** either entry point SHALL seed the ordered planner roles from that roster and resolve the consolidator through the shared routing rules
- **AND** the roster SHALL be pinned for the run's lifetime rather than replaced by a later classification

#### Scenario: An uncovered step resolves instead of failing

- **WHEN** a start selects a preset that declares no pool for an agent step of the resolved definition
- **THEN** startup SHALL resolve that step through the configured routes, definition defaults, and the built-in profile
- **AND** startup SHALL NOT fail for the missing pool

#### Scenario: Invalid fusion routing is rejected

- **WHEN** the resolved roster has gaps, duplicates, an unknown profile, or fewer than two or more than five entries
- **THEN** startup SHALL fail before workflow creation or agent launch with an actionable diagnostic

#### Scenario: Direct engine caller bypasses preparation

- **WHEN** a direct engine call violates a start-time state or capability invariant
- **THEN** the engine SHALL still reject it without relying solely on application preflight
