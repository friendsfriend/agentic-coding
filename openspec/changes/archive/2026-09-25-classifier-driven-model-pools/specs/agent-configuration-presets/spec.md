# Spec Delta

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Catalog-driven verification role list in preset editor

**Reason**: `core.verification` now has one grouped pool used by all verifier roles, so the editor no longer renders a per-verifier-role field and no role-name list is needed to build the editor.

**Migration**: Replace any stored per-role verification assignments with a single `core.verification` pool; the editor derives its fields from the classifiable step catalog, while triage selection validation continues to read the engine verifier-role catalog.

## ADDED Requirements

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
