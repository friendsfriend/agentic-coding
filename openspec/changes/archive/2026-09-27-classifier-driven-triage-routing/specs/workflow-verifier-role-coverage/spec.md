# Spec Delta

## MODIFIED Requirements

### Requirement: Registered verifier role catalog

The workflow SHALL register the verifier role set for `core.verification` as a
single engine-side catalog containing `quality-verifier`, `security-verifier`,
`performance-verifier`, `openspec-verifier`, `usability-verifier`,
`test-verifier`, `concurrency-verifier`, `migration-verifier`, and
`test-quality-verifier`. The roles that triage and the classifier may select
SHALL be that catalog minus `test-verifier`, filtered by the same definition
rule that excludes `openspec-verifier` when the definition declares no OpenSpec
surface. Triage selection SHALL be further limited to a subset of the roles the
classifier selected for the round.

#### Scenario: Triage selects a registered role
- **WHEN** a triage plan selects a verifier role present in the catalog, scopes it to changed files, and is otherwise valid
- **THEN** the workflow SHALL accept the plan and fan out one run for that role
- **AND** the accepted selection SHALL be recorded on the verification step for the round

#### Scenario: Triage selects an unregistered role
- **WHEN** a triage plan names a role outside the catalog
- **THEN** the workflow SHALL reject the plan as an invalid verifier role selection
- **AND** no verifier run SHALL launch from that plan

#### Scenario: Triage attempts to select the test verifier
- **WHEN** a triage plan names `test-verifier`
- **THEN** the workflow SHALL reject the plan as an invalid verifier role selection
- **AND** the complete test suite SHALL remain owned by the engine's automatic launch

#### Scenario: Definition excludes the OpenSpec verifier
- **WHEN** the active workflow definition declares no OpenSpec project surface
- **THEN** `openspec-verifier` SHALL be excluded from candidate roles and rejected if triage selects it
- **AND** every other catalog role SHALL remain selectable

#### Scenario: Triage duplicates a role
- **WHEN** a triage plan lists the same role more than once or assigns a role it did not list
- **THEN** the workflow SHALL reject the plan as an invalid verifier role selection

#### Scenario: Triage adds a role the classifier did not select
- **WHEN** a triage plan names a role that is in the catalog but was not part of the classifier's selection for the round
- **THEN** the workflow SHALL reject the plan as an invalid verifier role selection
- **AND** the same catalog validation SHALL apply to the classifier's own selection

### Requirement: Single-sourced verifier role catalog

The verifier role catalog SHALL be exposed from the verification step module as the single source of truth, and the engine's selection validation, triage validation, and the per-round classifier questions SHALL read that catalog instead of maintaining independent copies of the role names. The Settings preset editor SHALL route every verifier role through the one `core.verification` model pool and SHALL NOT maintain a per-role list of its own.

#### Scenario: Dashboard editor offers the catalog
- **WHEN** the dashboard preset editor renders the verification assignment fields
- **THEN** it SHALL offer the single `core.verification` pool
- **AND** it SHALL NOT list a per-role verification field or a role absent from the catalog

#### Scenario: Role set changes
- **WHEN** a verifier role is added to or removed from the catalog
- **THEN** engine selection validation, triage validation, and the classifier's per-role questions SHALL reflect the change without editing a second role-name list
- **AND** the single verification pool SHALL continue to cover every role

## ADDED Requirements

### Requirement: Verification with no domain verifier selected

A verification step entered with an empty role selection SHALL fan out the
engine-owned full-suite verifier role only, rather than defaulting to a domain
verifier. Such a round SHALL pass once that run reports without critical
findings.

#### Scenario: Empty selection runs the full suite only
- **WHEN** a round reaches verification with no selected domain verifier
- **THEN** the only role launched SHALL be the engine-owned full-suite verifier
- **AND** no default domain verifier SHALL be substituted

#### Scenario: Empty selection can still fail the round
- **WHEN** the full-suite run in an empty-selection round reports a critical finding
- **THEN** the round SHALL take the same failing path as any other round with critical findings
