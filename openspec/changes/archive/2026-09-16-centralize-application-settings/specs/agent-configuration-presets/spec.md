## MODIFIED Requirements

### Requirement: Preset management via home dashboard
The Settings agent models/presets page SHALL allow users to create, edit, and delete custom presets and custom agent profiles. A profile editor SHALL offer execution environment selection (`pi`, `opencode`, `opencode-v2`), model selection from the models available for the chosen environment, and an optional agent name where the runtime supports one. A preset editor SHALL let the user define the profile for all workflow steps and verification roles. Changes SHALL be persisted to the resolved agents configuration file, and Settings SHALL report any read or write failure to the user.

#### Scenario: User creates a profile
- **WHEN** the user completes the profile editor with execution environment, optional model, and optional agent name
- **THEN** the profile SHALL appear in Settings custom profile list and in persisted config
- **AND** no global default profile SHALL be created

#### Scenario: Model list reflects execution environment
- **WHEN** the user changes the execution environment in the profile editor
- **THEN** the selectable model list SHALL contain only models reported as available by that environment's runtime CLI

#### Scenario: User deletes a referenced profile
- **WHEN** the user attempts to delete a profile still referenced by a preset or route
- **THEN** deletion SHALL be refused with an indication of the referencing entries

#### Scenario: User edits a preset
- **WHEN** the user changes step assignments in a custom preset editor and confirms
- **THEN** the persisted preset SHALL reflect the new assignments for subsequent workflow starts

#### Scenario: Settings saves on Linux
- **WHEN** a user creates, edits, or deletes a custom profile or preset from Settings on Linux
- **THEN** the change SHALL be written to the same effective agents configuration source used for subsequent workflow starts
- **OR** Settings SHALL show the configuration error and leave the existing source unchanged

### Requirement: Plan-fusion preset assignments
The Settings preset editor SHALL allow a preset to assign profiles independently to `fusion.plan` roles `planner-1` through `planner-5` and to the `fusion.consolidate` step, while preserving the existing preset routing format and arbitrary role tables.

#### Scenario: User configures fusion planner profiles
- **WHEN** a user edits a preset from the Settings model configuration editor
- **THEN** the editor SHALL offer planner-1 through planner-5 assignments and a fusion consolidator assignment
- **AND** confirming the editor SHALL persist non-empty assignments under the corresponding `roles.fusion.plan` and `steps.fusion.consolidate` entries

#### Scenario: Existing preset assignments survive fusion editing
- **WHEN** a user edits and saves a preset that contains standard workflow assignments or role tables outside the fields being edited
- **THEN** those existing assignments SHALL remain unchanged in the persisted configuration
- **AND** unset optional fusion fields SHALL not be persisted as the literal `(unset)` value

### Requirement: Preset-based plan-fusion routing
A contextually started `plan-fusion` workflow SHALL resolve its planner and consolidator profiles using the selected preset's existing precedence rules, with per-planner role assignments taking precedence over step assignments and preset defaults.

#### Scenario: Planner role overrides are honored
- **WHEN** a selected preset assigns distinct profiles to `fusion.plan.planner-1` through `fusion.plan.planner-N` and assigns or can resolve `fusion.consolidate`
- **THEN** planner role N SHALL use its assigned profile
- **AND** the consolidator SHALL use the profile resolved for `fusion.consolidate`

#### Scenario: No preset behavior for other workflows is unchanged
- **WHEN** a user starts standard, direct-apply, or quick without selecting a preset
- **THEN** routing SHALL resolve exactly as it did before fusion planner fields were added

### Requirement: Catalog-driven verification role list in preset editor

The Settings preset editor's verification-role assignments SHALL be derived from the workflow engine's registered verifier role catalog rather than from a UI-local list of role names.

#### Scenario: Editor renders the registered roles
- **WHEN** a user opens the stored-preset editor on the role-assignment field
- **THEN** the editor SHALL offer one entry per registered verification role, excluding no registered role
- **AND** it SHALL offer no entry for a role the engine does not register

#### Scenario: Registered role set changes
- **WHEN** the engine catalog gains or loses a verification role
- **THEN** the editor SHALL reflect the new set without a second role-name list being edited
- **AND** saved presets containing assignments for roles outside the current catalog SHALL still load and persist without being rewritten

#### Scenario: Assignment persists for a newly registered role
- **WHEN** a user assigns a profile to a verification role the editor obtained from the catalog and confirms the preset
- **THEN** the assignment SHALL be persisted under the preset's role table for the verification step
- **AND** the workflow SHALL resolve that profile for that role when the preset is used
