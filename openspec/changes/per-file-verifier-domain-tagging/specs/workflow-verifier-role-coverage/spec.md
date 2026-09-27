# Spec Delta

## MODIFIED Requirements

### Requirement: Registered verifier role catalog

The workflow SHALL register the verifier role set for `core.verification` as a single engine-side catalog containing `quality-verifier`, `security-verifier`, `performance-verifier`, `openspec-verifier`, `usability-verifier`, `test-verifier`, `concurrency-verifier`, `migration-verifier`, and `test-quality-verifier`. The roles that may be selected SHALL be that catalog minus `test-verifier`, filtered by the same definition rule that excludes `openspec-verifier` when the definition declares no OpenSpec surface. A selected role's file scope SHALL come from the classifier's per-file role tags restricted to that selection, and a role with no tagged changed file SHALL be dropped from the round.

#### Scenario: Triage selects a registered role
- **WHEN** a role present in the catalog is selected for a round and at least one changed file is tagged for it
- **THEN** the workflow SHALL accept the selection and fan out one run for that role
- **AND** the accepted scope SHALL be recorded on the verification step for the round

#### Scenario: Triage selects an unregistered role
- **WHEN** a selection or tag names a role outside the catalog
- **THEN** the workflow SHALL reject it as an invalid verifier role selection
- **AND** no verifier run SHALL launch from it

#### Scenario: Triage attempts to select the test verifier
- **WHEN** a selection or tag names `test-verifier`
- **THEN** the workflow SHALL reject it as an invalid verifier role selection
- **AND** the complete test suite SHALL remain owned by the engine's automatic launch

#### Scenario: Definition excludes the OpenSpec verifier
- **WHEN** the active workflow definition declares no OpenSpec project surface
- **THEN** `openspec-verifier` SHALL be excluded from selected roles and from accepted tags
- **AND** every other catalog role SHALL remain selectable

#### Scenario: Triage duplicates a role
- **WHEN** a selection lists the same role more than once
- **THEN** the workflow SHALL reject it as an invalid verifier role selection
