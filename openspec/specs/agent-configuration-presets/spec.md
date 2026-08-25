# agent-configuration-presets Specification

## Purpose
TBD - created by archiving change implement-model-configuration-and-invalid-model-detection. Update Purpose after archive.
## Requirements
### Requirement: Agent configuration presets
Configuration SHALL support named agent configuration presets that assign an agent profile to workflow steps, optionally with per-role overrides within a step and a preset-level default profile. Presets SHALL be stored in the agents configuration so they can be committed to a repository.

#### Scenario: Preset is valid
- **WHEN** a preset references only existing profile names and assigns at most one profile per step and per step-role pair
- **THEN** the preset SHALL be available for selection

#### Scenario: Preset references unknown profile
- **WHEN** configuration parsing encounters a preset entry naming a profile that does not exist
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the error SHALL identify the preset, the entry, and the unknown profile name

### Requirement: Preset-based routing resolution
When a workflow starts with a selected preset, routing SHALL resolve each agent step from the preset's per-role override, then step assignment, then the preset's default profile. Steps not covered by the selected preset SHALL fall back to the existing global resolution chain.

#### Scenario: Workflow starts with selected preset
- **WHEN** a user selects a preset in the new workflow modal and submits the workflow
- **THEN** every routed step of the started workflow SHALL use the profile assigned by the preset
- **AND** the pinned routing SHALL be identical to what equivalent explicit route configuration would produce

#### Scenario: No preset is selected
- **WHEN** a workflow is started without selecting a preset
- **THEN** routing SHALL resolve exactly as before this capability existed

### Requirement: Preset coverage validation
When a workflow starts with a selected preset, the system SHALL verify the preset covers every agent step of the workflow definition, either by direct assignment or via resolvable fallback.

#### Scenario: Preset misses a required step without fallback
- **WHEN** a selected preset defines no assignment for an agent step and no preset or global default can resolve it
- **THEN** workflow startup SHALL fail before any agent launches
- **AND** the error SHALL name the uncovered step and the selected preset

### Requirement: Preset management via home dashboard
The agentic-coding home dashboard SHALL allow users to create, edit, and delete presets and to create, edit, and delete agent profiles. A profile editor SHALL offer execution environment selection (`pi`, `opencode`, `opencode-v2`), model selection from the models available for the chosen environment, and an optional agent name where the runtime supports one. A preset editor SHALL let the user define the profile for all workflow steps and verification roles. Changes SHALL be persisted to the config file from which the edited agents section was loaded.

#### Scenario: User creates a profile
- **WHEN** the user completes the profile editor with execution environment, model, and optional agent name
- **THEN** the profile SHALL appear in the dashboard profile list and in persisted config

#### Scenario: Model list reflects execution environment
- **WHEN** the user changes the execution environment in the profile editor
- **THEN** the selectable model list SHALL contain only models reported as available by that environment's runtime CLI

#### Scenario: User deletes a referenced profile
- **WHEN** the user attempts to delete a profile still referenced by a preset, route, or default
- **THEN** deletion SHALL be refused with an indication of the referencing entries

#### Scenario: User edits a preset
- **WHEN** the user changes step assignments in the preset editor and confirms
- **THEN** the persisted preset SHALL reflect the new assignments for subsequent workflow starts

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

