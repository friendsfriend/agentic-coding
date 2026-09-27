# agent-configuration-presets Specification

## Purpose
TBD - created by archiving change implement-model-configuration-and-invalid-model-detection. Update Purpose after archive.

## Requirements

### Requirement: Agent configuration presets

Configuration SHALL support named custom agent configuration presets that assign user-defined agent profiles to workflow steps through per-step model pools, optionally with a preset-level fallback profile. A custom preset SHALL declare at least one pool, and every pool entry SHALL reference an existing custom profile. Configuration SHALL be valid without `agents.default_profile`, profiles, routes, or custom presets. A preset that still carries the removed flat `easy`/`medium`/`hard`/`critical` keys or a `roles["core.verification"]` table SHALL be rejected. The built-in `use-default-model` preset SHALL not require a persisted profile reference and SHALL allow its harness to be configured as `pi`, `opencode`, or `opencode-v2` without a model. Custom presets SHALL be stored in an explicitly supplied effective user/project agents configuration, but the repository's default configuration SHALL NOT ship custom presets or profiles and custom entries SHALL NOT require a repository commit.

#### Scenario: Preset is valid
- **WHEN** a custom preset declares pools whose entries reference existing custom profile names, respecting each step's default-count rule
- **THEN** the preset SHALL be available for selection

#### Scenario: Preset references unknown profile
- **WHEN** configuration parsing encounters a custom preset pool entry naming a profile that does not exist
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the error SHALL identify the preset, the pool entry, and the unknown profile name

#### Scenario: Removed preset shape is rejected
- **WHEN** configuration parsing encounters a custom preset carrying flat `easy`/`medium`/`hard`/`critical` keys or a `roles["core.verification"]` table
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the error SHALL name the provenance file and point at Settings → Presets

#### Scenario: Agents configuration has no custom profiles
- **WHEN** configuration parsing encounters no agents section or an agents section with no profiles and no custom presets
- **THEN** configuration validation SHALL succeed
- **AND** the built-in `use-default-model` preset SHALL remain available

### Requirement: Preset-based routing resolution

For every classifiable step of a classifier-routed workflow, routing SHALL resolve each route from the pool entry the classifier selected, falling back to the pool's `default: true` entry when no selection is applied. For every other agent step, routing SHALL resolve from the preset's per-role override, then step assignment, then the preset's fallback profile, then any configured custom route. If no custom profile resolves a non-classifiable step, routing SHALL use the model-agnostic behavior of the harness configured for `use-default-model`.

#### Scenario: Workflow starts with selected preset
- **WHEN** a user selects a custom preset in the new workflow modal and submits a classifier-routed workflow
- **THEN** every classifiable step's route SHALL use its pool's classified or default entry
- **AND** uncovered non-classifiable assignments SHALL resolve through configured custom routes or `use-default-model`

#### Scenario: No preset is selected
- **WHEN** a user starts a classifier-routed workflow without selecting a custom preset
- **THEN** startup SHALL fail before any agent launches with the Settings → Presets hint
- **AND** a non-classifier workflow started without a preset SHALL still resolve through configured custom routes and `use-default-model`

### Requirement: Preset coverage validation

When a workflow starts with a selected custom preset and at preset switch, the system SHALL verify every classifiable step in the resolved definition has a valid pool, and every other agent step can resolve through a preset assignment, configured custom route, or the built-in `use-default-model` fallback. A missing or invalid pool SHALL fail start or reject the preset switch before any agent launches.

#### Scenario: Preset misses a classifiable step pool
- **WHEN** a selected preset defines no pool for a classifiable step in the resolved definition
- **THEN** workflow startup or preset switch SHALL fail before any agent launches
- **AND** the error SHALL point at Settings → Presets

#### Scenario: Preset misses a required step without fallback
- **WHEN** a selected custom preset defines no assignment for a non-classifiable agent step and no configured custom route resolves it
- **THEN** workflow startup SHALL use `use-default-model` for that step before any agent launches

### Requirement: Preset management via home dashboard

The Settings agent models/presets page SHALL allow users to create, edit, and delete custom presets and custom agent profiles. A profile editor SHALL offer execution environment selection (`pi`, `opencode`, `opencode-v2`), model selection from the models available for the chosen environment, and an optional agent name where the runtime supports one. A preset editor SHALL let the user define, per classifiable step, a model pool: a comma-separated list of labels plus one profile choice for each current label, derived live from the edited draft. For `fusion.plan` the editor SHALL additionally let the user mark each pool entry as default and SHALL enforce between two and five defaults when saving. Deleting or renaming a profile referenced by any pool entry SHALL be refused with the referencing entry identified. Changes SHALL be persisted to the resolved agents configuration file, and Settings SHALL report any read or write failure to the user.

#### Scenario: User creates a profile
- **WHEN** the user completes the profile editor with execution environment, optional model, and optional agent name
- **THEN** the profile SHALL appear in Settings custom profile list and in persisted config
- **AND** no global default profile SHALL be created

#### Scenario: Model list reflects execution environment
- **WHEN** the user changes the execution environment in the profile editor
- **THEN** the selectable model list SHALL contain only models reported as available by that environment's runtime CLI

#### Scenario: User edits a step pool
- **WHEN** the user enters a comma-separated label list for a classifiable step and assigns a profile to each current label
- **THEN** the persisted preset SHALL contain one pool entry per label with its chosen profile
- **AND** deleting a label from the list SHALL stop persisting that entry

#### Scenario: User deletes a referenced profile
- **WHEN** the user attempts to delete or rename a profile still referenced by a preset pool entry or route
- **THEN** the action SHALL be refused with an indication of the referencing entries

#### Scenario: Fusion defaults are enforced
- **WHEN** the user saves a `fusion.plan` pool with fewer than two or more than five entries marked default
- **THEN** the save SHALL be refused identifying the fusion default rule

#### Scenario: User edits a preset
- **WHEN** the user changes a preset's step pool entries in the custom preset editor and confirms
- **THEN** the persisted preset SHALL reflect the new pool assignments for subsequent workflow starts

#### Scenario: Settings saves on Linux
- **WHEN** a user creates, edits, or deletes a custom profile or preset from Settings on Linux
- **THEN** the change SHALL be written to the same effective agents configuration source used for subsequent workflow starts
- **OR** Settings SHALL show the configuration error and leave the existing source unchanged

### Requirement: Plan-fusion preset assignments

The Settings preset editor SHALL represent the fusion plan-fusion routing as the `fusion.plan` model pool: an ordered list of labelled profile entries with between two and five entries marked default, plus the `fusion.consolidate` single-select pool. The editor SHALL preserve every preset assignment outside the edited pool fields.

#### Scenario: User configures the fusion planner pool
- **WHEN** a user edits a preset from the Settings model configuration editor
- **THEN** the editor SHALL offer the `fusion.plan` pool with a default toggle per entry and the `fusion.consolidate` pool
- **AND** confirming the editor SHALL persist the non-empty pool entries

#### Scenario: User configures fusion planner profiles
- **WHEN** a user edits a preset from the Settings model configuration editor
- **THEN** the editor SHALL offer the `fusion.plan` pool with per-entry default toggles and the `fusion.consolidate` pool
- **AND** confirming the editor SHALL persist the non-empty pool entries

#### Scenario: Existing preset assignments survive fusion editing
- **WHEN** a user edits and saves a preset that contains standard workflow assignments or role tables outside the fields being edited
- **THEN** those existing assignments SHALL remain unchanged in the persisted configuration
- **AND** unset optional fusion fields SHALL not be persisted

### Requirement: Preset-based plan-fusion routing

A contextually started fusion workflow SHALL resolve its planner roster and consolidator profile from the selected preset's `fusion.plan` and `fusion.consolidate` pools. Before classification the planner roles SHALL use the `fusion.plan` tagged defaults; after classification they SHALL use the classified roster.

#### Scenario: Tagged defaults seed the fan-out
- **WHEN** a fusion workflow starts with no explicit classifier roster yet
- **THEN** the planner roles SHALL use the `fusion.plan` pool's tagged default entries
- **AND** the consolidator SHALL use the classified or default `fusion.consolidate` entry

#### Scenario: Classified roster overrides the defaults
- **WHEN** the plan-phase classifier returns a roster of distinct profiles
- **THEN** the planner roles SHALL use that roster
- **AND** the remaining steps SHALL keep the routing resolved from their own pools

#### Scenario: Planner role overrides are honored
- **WHEN** a classified roster or the `fusion.plan` tagged defaults supply distinct planner profiles and a resolvable `fusion.consolidate` profile
- **THEN** planner role N SHALL use its assigned profile
- **AND** the consolidator SHALL use the resolved `fusion.consolidate` profile

#### Scenario: No preset behavior for other workflows is unchanged
- **WHEN** a user starts a non-fusion workflow with a selected preset
- **THEN** routing SHALL resolve from each classifiable step's pool and non-classifiable precedence rules

### Requirement: Preset pool hard-break migration and notification

Configuration migration SHALL detect persisted custom presets and strip them (keeping profiles, `default_profile`, routes, `role_routes`, and `definition_defaults`), using the existing preview/apply, backup, journal, and staged-rename machinery and remaining idempotent. The migration report SHALL state the number of presets removed and direct the user to recreate them as model pools in Settings → Presets. The TUI SHALL show a persistent banner while the effective configuration has no custom presets, and a classifier-routed start without a preset SHALL repeat the Settings → Presets hint.

#### Scenario: Migration strips presets
- **WHEN** configuration migration is applied to a configuration containing custom presets
- **THEN** the published configuration SHALL contain no custom presets and SHALL retain profiles, default profile, routes, role routes, and definition defaults
- **AND** the report SHALL state how many presets were removed and point at Settings → Presets

#### Scenario: Migration is idempotent
- **WHEN** migration is applied again after presets were stripped
- **THEN** it SHALL report no preset removal and SHALL not modify unrelated configuration

#### Scenario: Effective config has no custom presets
- **WHEN** the TUI is shown an effective configuration with no custom presets
- **THEN** it SHALL show a persistent banner explaining that model pools must be recreated in Settings → Presets
- **AND** the built-in `use-default-model` preset SHALL remain selectable

### Requirement: Stage gate policy resolution

A custom preset SHALL accept an optional `gates` table with one entry per stage
(`planApproval`, `verification`, `developerReview`, `wiki`), each value being
either `always` or `auto`, and the agents configuration SHALL accept an optional
global `gates` table with the same shape. A preset entry SHALL take precedence
over the global table, the global table over the default, and the default SHALL
be `always`. Configuration SHALL remain valid when no `gates` table is declared
anywhere, a `gates` entry naming an unknown stage or carrying a value other than
`always` or `auto` SHALL be rejected before any workflow starts with a
diagnostic naming the stage and the offending value, and the resolved policy of
each stage SHALL be readable by a workflow that selected the preset. The
repository's default configuration SHALL NOT ship an `auto` gate policy, so a
workflow that configures nothing still runs every stage.

#### Scenario: Preset without gates resolves to always

- **WHEN** a workflow starts with a preset that declares no `gates` table and a
  configuration with no global `gates` table
- **THEN** every stage's resolved policy SHALL be `always`

#### Scenario: Global gates table is the preset fallback

- **WHEN** the global agents table sets `wiki` to `auto` and the selected preset
  declares no `gates` entry for `wiki`
- **THEN** the wiki gate's resolved policy SHALL be `auto`

#### Scenario: Preset gates table wins over the global table

- **WHEN** the global agents table sets `developerReview` to `auto` and the
  selected preset sets it to `always`
- **THEN** the developer review gate's resolved policy SHALL be `always`

#### Scenario: Invalid gate value is rejected

- **WHEN** configuration parsing encounters a `gates` entry whose value is not
  `always` or `auto`
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the diagnostic SHALL name the stage and the offending value

#### Scenario: Unknown gate stage is rejected

- **WHEN** configuration parsing encounters a `gates` entry naming a stage other
  than the four gate stages
- **THEN** configuration validation SHALL fail before any workflow starts

#### Scenario: Gate configuration needs no profile

- **WHEN** a preset declares only a `gates` table alongside its pools
- **THEN** the preset SHALL remain subject to the existing requirement to declare
  at least one model pool
- **AND** the gate table SHALL NOT require any profile reference

### Requirement: Stage gates in the preset editor

The Settings preset editor SHALL offer a stage-gates section with one selection
per stage — plan approval, verification, developer review, and wiki — each
restricted to the values `always` and `auto`, built from the editor's existing
text and select form primitives without introducing a new field kind. The editor
SHALL show the resolved default for a stage the draft does not set. Saving SHALL
persist the edited gate values, SHALL preserve every preset assignment outside
the gate section including pool entries, step assignments, role tables, and the
description, and a read or write failure SHALL be reported to the user without
changing the existing configuration.

#### Scenario: Editor offers one selection per stage

- **WHEN** a user opens a preset in the Settings preset editor
- **THEN** the editor SHALL show one `always`/`auto` selection for each of plan
  approval, verification, developer review, and wiki

#### Scenario: User makes a stage automatic

- **WHEN** a user sets the verification stage of a preset to `auto` and confirms
- **THEN** the persisted preset SHALL declare `verification: auto`
- **AND** stages the user did not change SHALL keep their prior value or the
  resolved default

#### Scenario: Saving preserves unedited preset content

- **WHEN** a user changes only gate values in a preset that carries model pools,
  step assignments, role tables, and a description
- **THEN** all of those SHALL remain unchanged in the persisted preset

#### Scenario: A failed save leaves the configuration unchanged

- **WHEN** persisting the edited preset fails
- **THEN** Settings SHALL report the failure and the existing configuration SHALL
  be left unchanged
