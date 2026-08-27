# agent-configuration-presets Specification

## Purpose
TBD - created by archiving change implement-model-configuration-and-invalid-model-detection. Update Purpose after archive.
## Requirements
### Requirement: Agent configuration presets
Configuration SHALL support named custom agent configuration presets that assign user-defined agent profiles to workflow steps, optionally with per-role overrides within a step and a preset-level fallback profile. A configuration SHALL be valid without `agents.default_profile`, profiles, routes, or custom presets. The built-in `use-default-model` preset SHALL not require a persisted profile reference and SHALL allow its harness to be configured as `pi`, `opencode`, or `opencode-v2` without a model. Custom presets SHALL be stored in an explicitly supplied effective user/project agents configuration, but the repository's default configuration SHALL NOT ship custom presets or profiles and custom entries SHALL NOT require a repository commit.

#### Scenario: Preset is valid
- **WHEN** a custom preset references only existing custom profile names and assigns at most one profile per step and per step-role pair
- **THEN** the preset SHALL be available for selection

#### Scenario: Preset references unknown profile
- **WHEN** configuration parsing encounters a custom preset entry naming a profile that does not exist
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the error SHALL identify the preset, the entry, and the unknown profile name

#### Scenario: Agents configuration has no custom profiles
- **WHEN** configuration parsing encounters no agents section or an agents section with no profiles and no custom presets
- **THEN** configuration validation SHALL succeed
- **AND** the built-in `use-default-model` preset SHALL remain available

### Requirement: Preset-based routing resolution
When a workflow starts with a selected custom preset, routing SHALL resolve each agent step from the preset's per-role override, then step assignment, then the preset's fallback profile, then any configured custom route. If no custom profile resolves the step, routing SHALL use the model-agnostic behavior of the harness configured for `use-default-model`.

#### Scenario: Workflow starts with selected preset
- **WHEN** a user selects a custom preset in the new workflow modal and submits the workflow
- **THEN** every assignment defined by that preset SHALL use its selected profile
- **AND** uncovered assignments SHALL resolve through configured custom routes or `use-default-model`

#### Scenario: No preset is selected
- **WHEN** a user starts a workflow without selecting a custom preset
- **THEN** configured custom routes SHALL be used where present
- **AND** all remaining assignments SHALL use `use-default-model`

### Requirement: Preset coverage validation
When a workflow starts with a selected custom preset, the system SHALL verify every agent step can resolve through a preset assignment, configured custom route, or the built-in `use-default-model` fallback.

#### Scenario: Preset misses a required step without fallback
- **WHEN** a selected custom preset defines no assignment for an agent step and no configured custom route resolves it
- **THEN** workflow startup SHALL use `use-default-model` for that step before any agent launches

### Requirement: Preset management via home dashboard
The agentic-coding home dashboard SHALL allow users to create, edit, and delete custom presets and custom agent profiles. A profile editor SHALL offer execution environment selection (`pi`, `opencode`, `opencode-v2`), model selection from the models available for the chosen environment, and an optional agent name where the runtime supports one. A preset editor SHALL let the user define the profile for all workflow steps and verification roles. Changes SHALL be persisted to the resolved agents configuration file, and the dashboard SHALL report any read or write failure to the user.

#### Scenario: User creates a profile
- **WHEN** the user completes the profile editor with execution environment, optional model, and optional agent name
- **THEN** the profile SHALL appear in the dashboard custom profile list and in persisted config
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

#### Scenario: Dashboard saves on Linux
- **WHEN** a user creates, edits, or deletes a custom profile or preset from the dashboard on Linux
- **THEN** the change SHALL be written to the same effective agents configuration source used for subsequent workflow starts
- **OR** the dashboard SHALL show the configuration error and leave the existing source unchanged

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

