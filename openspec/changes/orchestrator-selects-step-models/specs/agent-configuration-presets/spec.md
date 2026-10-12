## RENAMED Requirements

- FROM: `### Requirement: Preset coverage validation`
- TO: `### Requirement: Preset resolution validation`

## MODIFIED Requirements

### Requirement: Agent configuration presets

Configuration SHALL support named custom agent configuration presets that assign user-defined agent profiles to workflow steps through per-step model pools, optionally with a preset-level fallback profile. A custom preset SHALL declare at least one pool, and every pool value SHALL reference an existing custom profile — one profile name for a single-model pool, and two to five distinct profile names for the roster pool. Configuration SHALL be valid without `agents.default_profile`, profiles, routes, or custom presets. A preset that still carries the removed flat `easy`/`medium`/`hard`/`critical` keys or a `roles["core.verification"]` table SHALL be rejected. The built-in `use-default-model` preset SHALL not require a persisted profile reference and SHALL allow its harness to be configured as `pi`, `opencode`, or `opencode-v2` without a model. Custom presets SHALL be stored in an explicitly supplied effective user/project agents configuration, but the repository's default configuration SHALL NOT ship custom presets or profiles and custom entries SHALL NOT require a repository commit.

#### Scenario: Preset is valid
- **WHEN** a custom preset declares pools whose values reference existing custom profile names, respecting the single-model and roster-shape rules
- **THEN** the preset SHALL be available for selection

#### Scenario: Preset references unknown profile
- **WHEN** configuration parsing encounters a custom preset pool value naming a profile that does not exist
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the error SHALL identify the preset, the step, and the unknown profile name

#### Scenario: Removed preset shape is rejected
- **WHEN** configuration parsing encounters a custom preset carrying flat `easy`/`medium`/`hard`/`critical` keys or a `roles["core.verification"]` table
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the error SHALL name the provenance file and point at Settings → Presets

#### Scenario: Agents configuration has no custom profiles
- **WHEN** configuration parsing encounters no agents section or an agents section with no profiles and no custom presets
- **THEN** configuration validation SHALL succeed
- **AND** the built-in `use-default-model` preset SHALL remain available

### Requirement: Preset-based routing resolution

For every pool-bearing step, routing SHALL resolve the step's model from the start's explicit selection when one named that step, then from the preset's pool value for that step, and otherwise through the preset's per-role override, then step assignment, then the preset's fallback profile, then any configured custom route, and finally the model-agnostic behavior of the harness configured for `use-default-model`. A preset that declares no pool for a step SHALL leave that step to the remaining rules rather than failing the start.

#### Scenario: Workflow starts with selected preset
- **WHEN** a user selects a custom preset in the new workflow modal and submits a workflow
- **THEN** every step the start did not name SHALL use the profile its pool value names
- **AND** uncovered steps SHALL resolve through configured custom routes or `use-default-model`

#### Scenario: Explicit selection wins over the preset
- **WHEN** a start names a profile for a step whose selected preset also declares one
- **THEN** the step SHALL use the named profile
- **AND** every other step SHALL keep the preset's models

#### Scenario: No preset is selected
- **WHEN** a workflow is started without selecting a custom preset
- **THEN** every step SHALL resolve through the explicit selection, configured custom routes, definition defaults, and `use-default-model`
- **AND** the start SHALL NOT be refused for the missing preset

### Requirement: Preset resolution validation

When a workflow starts with a selected custom preset, and at preset switch, the system SHALL verify that every pool value names an existing profile, that the roster pool holds two to five distinct profiles, and that every resolved profile passes its step's declared capability requirements and the model-availability preflight. The system SHALL NOT require a selected preset and SHALL NOT refuse a start because a step has no pool value: such a step resolves through the fallback chain before any agent launches.

#### Scenario: Preset misses a step model
- **WHEN** a selected preset declares no pool for an agent step in the resolved definition
- **THEN** the start SHALL resolve that step through the configured routes, definition defaults, or `use-default-model`
- **AND** no agent SHALL launch with a profile that failed its step's requirements

#### Scenario: Invalid pool value fails before launch
- **WHEN** a resolved preset pool names an unknown profile or a roster of the wrong shape
- **THEN** the start or preset switch SHALL fail before any agent launches with a diagnostic pointing at Settings → Presets

### Requirement: Preset management via home dashboard

The Settings agent models/presets page SHALL allow users to create, edit, and delete custom presets and custom agent profiles. A profile editor SHALL offer execution environment selection (`pi`, `opencode`, `opencode-v2`), model selection from the models available for the chosen environment, and an optional agent name where the runtime supports one. A preset editor SHALL let the user choose, for each pool-bearing step, exactly one profile: a single-model step SHALL offer one profile selection, and the roster step SHALL offer an ordered selection of two to five distinct profiles. Deleting or renaming a profile referenced by any pool value or route SHALL be refused with the referencing entry identified. Changes SHALL be persisted to the resolved agents configuration file, and Settings SHALL report any read or write failure to the user.

#### Scenario: User creates a profile
- **WHEN** the user completes the profile editor with execution environment, optional model, and optional agent name
- **THEN** the profile SHALL appear in Settings custom profile list and in persisted config
- **AND** no global default profile SHALL be created

#### Scenario: Model list reflects execution environment
- **WHEN** the user changes the execution environment in the profile editor
- **THEN** the selectable model list SHALL contain only models reported as available by that environment's runtime CLI

#### Scenario: User chooses a step's model
- **WHEN** the user selects one profile for a pool-bearing step in the preset editor
- **THEN** the persisted preset SHALL name that profile for the step
- **AND** the previously named profile SHALL no longer be persisted for it

#### Scenario: User deletes a referenced profile
- **WHEN** the user attempts to delete or rename a profile still referenced by a preset pool value or route
- **THEN** the action SHALL be refused with an indication of the referencing entries

#### Scenario: Roster size and distinctness are enforced
- **WHEN** the user saves a roster that holds fewer than two or more than five profiles, or repeats a profile
- **THEN** the save SHALL be refused identifying the roster rule

#### Scenario: User edits a preset
- **WHEN** the user changes a preset's step models in the custom preset editor and confirms
- **THEN** the persisted preset SHALL reflect the new pool values for subsequent workflow starts

#### Scenario: Settings saves on Linux
- **WHEN** a user creates, edits, or deletes a custom profile or preset from Settings on Linux
- **THEN** the change SHALL be written to the same effective agents configuration source used for subsequent workflow starts
- **OR** Settings SHALL show the configuration error and leave the existing source unchanged

### Requirement: Plan-fusion preset assignments

The Settings preset editor SHALL represent the fusion plan-fusion routing as the `fusion.plan` roster: an ordered list of two to five distinct profiles, plus the single-profile `fusion.consolidate` pool. The editor SHALL preserve every preset assignment outside the edited pool fields.

#### Scenario: User configures the fusion planner pool
- **WHEN** a user edits a preset from the Settings model configuration editor
- **THEN** the editor SHALL offer the `fusion.plan` roster as an ordered profile selection of two to five distinct profiles and the single-profile `fusion.consolidate` pool
- **AND** confirming the editor SHALL persist the roster entries

#### Scenario: Existing preset assignments survive fusion editing
- **WHEN** a user edits and saves a preset that contains standard workflow assignments or role tables outside the fields being edited
- **THEN** those existing assignments SHALL remain unchanged in the persisted configuration
- **AND** unset optional fusion fields SHALL not be persisted

### Requirement: Preset-based plan-fusion routing

A contextually started fusion workflow SHALL resolve its planner roster from the start's explicit roster when one was supplied and otherwise from the selected preset's `fusion.plan` list, and its consolidator profile from the preset's `fusion.consolidate` pool or the fallback chain. The resolved roster SHALL hold two to five distinct profiles and SHALL be pinned for the run's lifetime.

#### Scenario: Preset list seeds the fan-out
- **WHEN** a fusion workflow starts with no explicit roster and a preset whose `fusion.plan` list holds distinct profiles
- **THEN** the planner roles SHALL use those profiles in order
- **AND** the consolidator SHALL use the preset's `fusion.consolidate` profile

#### Scenario: Explicit roster overrides the list
- **WHEN** a fusion start names a roster of distinct profiles and the preset also declares one
- **THEN** the planner roles SHALL use the explicit roster
- **AND** every other step SHALL keep the routing resolved from the preset and the fallback chain

#### Scenario: Planner role overrides are honored
- **WHEN** the roster supplies distinct planner profiles and a resolvable `fusion.consolidate` profile
- **THEN** planner role N SHALL use its assigned profile
- **AND** the consolidator SHALL use the resolved `fusion.consolidate` profile

#### Scenario: No preset behavior for other workflows is unchanged
- **WHEN** a user starts a non-fusion workflow with a selected preset
- **THEN** routing SHALL resolve from the explicit selection, each step's pool value, and the fallback chain

### Requirement: Preset pool hard-break migration and notification

Configuration migration SHALL convert persisted custom presets whose pools use the legacy list shape into the single-model shape: each single-model pool SHALL become the profile of its entry tagged `default: true` and the roster pool SHALL become its tagged default profiles, using the existing preview/apply, backup, journal, and staged-rename machinery and remaining idempotent. The migration report SHALL state the number of presets converted and the steps whose candidate lists were collapsed. Presets SHALL NOT be stripped: profiles, `default_profile`, routes, `role_routes`, and `definition_defaults` SHALL be preserved, and the removed recreate-your-presets banner SHALL NOT be shown.

#### Scenario: Migration converts list-shaped pools
- **WHEN** configuration migration is applied to a configuration containing presets with list-shaped pools
- **THEN** the published configuration SHALL carry one profile per single-model pool and the tagged defaults for the roster pool
- **AND** the report SHALL state how many presets were converted and which steps were collapsed

#### Scenario: Migration is idempotent
- **WHEN** migration is applied again after the presets were converted
- **THEN** it SHALL report no conversion and SHALL not modify unrelated configuration

#### Scenario: Unconverted configuration keeps working
- **WHEN** a workflow starts from a configuration whose presets still carry list-shaped pools
- **THEN** every pool SHALL resolve to its normalized profile
- **AND** the workflow SHALL start without a configuration rewrite
