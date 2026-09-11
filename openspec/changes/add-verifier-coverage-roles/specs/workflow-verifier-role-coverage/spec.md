## ADDED Requirements

### Requirement: Registered verifier role catalog

The workflow SHALL register the verifier role set for `core.verification` as a single engine-side catalog containing `quality-verifier`, `security-verifier`, `performance-verifier`, `openspec-verifier`, `usability-verifier`, `test-verifier`, `concurrency-verifier`, `migration-verifier`, and `test-quality-verifier`. Triage selection SHALL be limited to that catalog minus `test-verifier`.

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

### Requirement: Per-role verifier instruction asset

Each catalog verifier role SHALL be pinned with exactly one role instruction asset named `verification-<role id without the verifier suffix>.md`, and an assignment SHALL inject only its own role's variant asset out of the assets pinned for the verification step.

#### Scenario: Role resolves its own asset
- **WHEN** a verifier run is assigned for a catalog role
- **THEN** the assignment SHALL include that role's own `verification-<role>.md` asset
- **AND** SHALL NOT include another role's variant asset

#### Scenario: Role has no pinned asset
- **WHEN** a registered role has no matching pinned `verification-<role>.md` asset
- **THEN** registration SHALL fail before any workflow starts

#### Scenario: Similar role ids do not collide
- **WHEN** a role id is a prefix of another role id, such as `test` and `test-quality`
- **THEN** each role SHALL resolve its own exact-name asset
- **AND** asset resolution SHALL NOT match by prefix

### Requirement: Concurrency verification remit

The `concurrency-verifier` role SHALL review the assigned changed files for introduced concurrency, ordering, and reentrancy defects in shared mutable state, and SHALL report findings only for concrete defects it can evidence.

#### Scenario: Concurrency defect is evidenced
- **WHEN** the assigned files introduce a race, an unguarded ordering assumption, or unsafe reentrancy in shared state
- **THEN** the role SHALL report a finding naming the repository-relative path and 1-based line
- **AND** the finding severity SHALL be critical only when the defect can corrupt state or lose work

#### Scenario: No concurrency surface is touched
- **WHEN** the assigned files contain no shared mutable state, concurrent access, or retry ordering behavior
- **THEN** the role SHALL report no finding

#### Scenario: Concurrency role stays in scope
- **WHEN** the role completes its review
- **THEN** it SHALL NOT edit code, coordinate sibling verifiers, launch other agents, or run the complete test suite

### Requirement: Migration verification remit

The `migration-verifier` role SHALL review the assigned changed files for persisted-state and schema-compatibility defects, including compatibility of written formats and versions, the upgrade path for state written by an earlier schema or definition, atomicity of writes, and rollback behavior after a failed transition.

#### Scenario: Persisted format change is incompatible
- **WHEN** the assigned files change a persisted format, version, or field meaning without a compatible read path for existing state
- **THEN** the role SHALL report a finding naming the repository-relative path and 1-based line

#### Scenario: Non-atomic persisted write
- **WHEN** the assigned files can leave persisted state partially written or unrecoverable after an interrupted or failed transition
- **THEN** the role SHALL report a finding describing the partial-write window

#### Scenario: No persisted state is touched
- **WHEN** the assigned files change no persisted format, schema, version, or state-transition write path
- **THEN** the role SHALL report no finding

#### Scenario: Migration role stays in scope
- **WHEN** the role completes its review
- **THEN** it SHALL NOT migrate live state, edit code, or modify workflow state

### Requirement: Test quality verification remit

The `test-quality-verifier` role SHALL review whether the changed behavior is asserted by tests: whether new or changed behavior has any covering assertion, whether those assertions fail when the logic breaks, and whether a test merely restates the implementation. It SHALL use only focused checks for the assigned scope and SHALL NOT run the complete repository test suite.

#### Scenario: Changed behavior has no covering assertion
- **WHEN** the assigned scope introduces or changes behavior with no test asserting it
- **THEN** the role SHALL report a finding naming the repository-relative path and 1-based line of the unasserted behavior

#### Scenario: Assertion cannot fail
- **WHEN** a test asserting the changed behavior would still pass if the logic were broken, or restates the implementation without an independent expectation
- **THEN** the role SHALL report a finding identifying the weakened assertion

#### Scenario: Changed behavior is adequately asserted
- **WHEN** the assigned scope's changed behavior is asserted by tests that fail when the logic breaks
- **THEN** the role SHALL report no finding

#### Scenario: Test quality role does not run the complete suite
- **WHEN** the role needs evidence about the changed scope
- **THEN** it SHALL run only the focused checks named for its assignment
- **AND** it SHALL NOT run the repository's complete test suite

### Requirement: Complete-suite ownership remains with the test verifier

After every selected verifier run for a round reports, the workflow SHALL launch `test-verifier` exactly once if the complete test suite has not already run in that round, regardless of whether `test-quality-verifier` was selected.

#### Scenario: Selected verifiers pass without the test verifier
- **WHEN** all selected verifier runs report no critical finding and the complete suite has not run in the round
- **THEN** the workflow SHALL launch `test-verifier` before the round can pass
- **AND** the round SHALL NOT pass until that run reports

#### Scenario: Test quality verifier does not replace the test verifier
- **WHEN** `test-quality-verifier` is selected and reports no critical finding
- **THEN** the workflow SHALL still launch `test-verifier` once for the round

#### Scenario: Suite already ran in the round
- **WHEN** the complete suite has already run in the round
- **THEN** the workflow SHALL NOT launch `test-verifier` a second time

### Requirement: Single-sourced verifier role catalog

The verifier role catalog SHALL be exposed from the verification step module as the single source of truth, and the engine's selection validation, triage validation, and dashboard role editors SHALL read that catalog instead of maintaining independent copies of the role names.

#### Scenario: Dashboard editor offers the catalog
- **WHEN** the dashboard model-configuration editor lists verifier roles
- **THEN** it SHALL list every role in the engine catalog
- **AND** it SHALL NOT list a role absent from the catalog

#### Scenario: Role set changes
- **WHEN** a verifier role is added to or removed from the catalog
- **THEN** engine selection validation and the dashboard editor SHALL reflect the change without editing a second role-name list

### Requirement: Additive verifier role registration

Adding a verifier role SHALL be additive: existing role ids, their instruction asset names, and their relative order SHALL be preserved, and a workflow already in flight SHALL keep the role behavior and pinned instruction assets it started with.

#### Scenario: Existing roles are preserved
- **WHEN** the catalog gains a role
- **THEN** every previously registered role SHALL keep its id, its instruction asset name, and its relative order

#### Scenario: In-flight workflow is unaffected
- **WHEN** a workflow is already running while the catalog changes
- **THEN** that workflow SHALL keep its pinned instruction assets and previously selectable roles
- **AND** new roles SHALL apply only to newly started workflows
