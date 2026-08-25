## ADDED Requirements

### Requirement: Plan-fusion preset assignments
The dashboard preset editor SHALL allow a preset to assign profiles independently to `fusion.plan` roles `planner-1` through `planner-5` and to the `fusion.consolidate` step, while preserving the existing preset routing format and arbitrary role tables.

#### Scenario: User configures fusion planner profiles
- **WHEN** a user edits a preset from the model configuration modal
- **THEN** the editor SHALL offer planner-1 through planner-5 assignments and a fusion consolidator assignment
- **AND** confirming the editor SHALL persist non-empty assignments under the corresponding `roles.fusion.plan` and `steps.fusion.consolidate` entries

#### Scenario: Existing preset assignments survive fusion editing
- **WHEN** a user edits and saves a preset that contains standard workflow assignments or role tables outside the fields being edited
- **THEN** those existing assignments SHALL remain unchanged in the persisted configuration
- **AND** unset optional fusion fields SHALL not be persisted as the literal `(unset)` value

### Requirement: Preset-based plan-fusion routing
A dashboard-started `plan-fusion` workflow SHALL resolve its planner and consolidator profiles using the selected preset's existing precedence rules, with per-planner role assignments taking precedence over step assignments and preset defaults.

#### Scenario: Planner role overrides are honored
- **WHEN** a selected preset assigns distinct profiles to `fusion.plan.planner-1` through `fusion.plan.planner-N` and assigns or can resolve `fusion.consolidate`
- **THEN** planner role N SHALL use its assigned profile
- **AND** the consolidator SHALL use the profile resolved for `fusion.consolidate`

#### Scenario: No preset behavior for other workflows is unchanged
- **WHEN** a user starts standard, direct-apply, or quick without selecting a preset
- **THEN** routing SHALL resolve exactly as it did before fusion planner fields were added
