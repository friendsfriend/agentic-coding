# Spec Delta

## ADDED Requirements

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
