# Spec Delta

## Purpose

Define per-step, user-labelled model pools and the two-pass System One
classifier routing that selects one pool entry per classifiable workflow step
(or a planning roster for fusion), with deterministic default fallback.

## ADDED Requirements

### Requirement: Per-step model pools

A custom agent preset SHALL define its routing as `pools`: a table keyed by
classifiable step id whose value is an ordered list of entries. Each entry SHALL
carry a `label`, a `profile` naming a defined agent profile, an optional
`criteria` that MAY be a string, object, array, or null, and an optional
`default` boolean. Labels SHALL be unique slugs within their pool. A
single-select pool SHALL declare exactly one entry with `default: true`; the
`fusion.plan` roster pool SHALL declare between two and five entries with
`default: true`. A classifiable step with no pool, an unknown profile in a pool,
a duplicate label, or a default-count outside its step's rule SHALL be a hard
configuration error whose message names the provenance file and points at
Settings → Presets.

#### Scenario: Valid single-select pool

- **WHEN** a preset declares a classifiable single-select step pool with unique labels, known profiles, and exactly one `default: true` entry
- **THEN** the preset SHALL parse and the pool SHALL be usable for classifier routing

#### Scenario: Valid fusion roster pool

- **WHEN** a preset declares a `fusion.plan` pool with two to five `default: true` entries naming distinct known profiles
- **THEN** the preset SHALL parse and the tagged entries SHALL be usable as the roster fallback

#### Scenario: Classifiable step has no pool

- **WHEN** a resolved workflow definition contains a classifiable step whose preset has no pool
- **THEN** startup or preset switch SHALL fail before any agent launches
- **AND** the error SHALL point at Settings → Presets

#### Scenario: Pool entry rules are violated

- **WHEN** a pool repeats a label, names an unknown profile, or has a default count other than exactly one for a single step or two to five for `fusion.plan`
- **THEN** configuration parsing SHALL fail and identify the preset, the step, and the violating entry

#### Scenario: Structured criteria are passed through

- **WHEN** a pool entry's `criteria` is a string, object, array, or null
- **THEN** the value SHALL be accepted unchanged and carried into the classifier question

### Requirement: Classifiable step mode metadata

The workflow SHALL declare a classification mode for each classifiable step:
`single` for `core.plan`, `fusion.consolidate`, `core.implementation`,
`core.triage`, `core.verification`, `core.wiki`, and `core.archive`; `roster`
for `fusion.plan`. Every other step SHALL NOT be classifiable and SHALL NOT be
asked of the classifier. All verifier roles of `core.verification` SHALL share
that step's single pool.

#### Scenario: Only classifiable steps are asked

- **WHEN** a routing pass builds its questions
- **THEN** it SHALL include one question per classifiable step present in the resolved definition and no question for any other step

#### Scenario: Verifier roles share one pool

- **WHEN** triage selects several verifier roles for a round
- **THEN** every selected verifier role SHALL resolve through the one profile the classifier selected for `core.verification`
- **AND** no per-verifier-role pool or profile field SHALL be consulted

### Requirement: Two-pass classifier routing

Classifier routing SHALL run in two passes, each a single System One request
carrying all of that pass's step questions in parallel. `core.route-plan` SHALL
run before planning with the task as state and SHALL ask the `core.plan` and
`fusion.consolidate` pools present in the definition plus, for a fusion
definition, the `fusion.plan` roster. `core.route-apply` SHALL run after plan
approval with the plan artifacts as state and SHALL ask the implementation,
triage, verification, wiki, and archive pools present in the definition.

#### Scenario: Route-plan resolves pre-approval steps

- **WHEN** a fusion definition starts and reaches `core.route-plan`
- **THEN** the single request SHALL carry the `core.plan`, `fusion.consolidate`, and `fusion.plan` roster questions
- **AND** the state SHALL be the task only

#### Scenario: Route-apply resolves post-approval steps

- **WHEN** a plan is approved and the workflow reaches `core.route-apply`
- **THEN** the single request SHALL carry the implementation, triage, verification, wiki, and archive questions present in the definition
- **AND** the state SHALL be the plan artifacts

#### Scenario: One request per pass

- **WHEN** a routing pass collects questions for several classifiable steps
- **THEN** it SHALL issue exactly one classifier request containing every question in parallel
- **AND** it SHALL NOT issue one request per step

### Requirement: Single-select choice with confidence gate

For a `single` step the classifier SHALL ask a TypeSafe `choice` question whose
criteria are the pool entries' criteria, and SHALL apply the returned `choice`
only when the answer's `confidence` is at least 0.5. A choice below that floor
SHALL keep the pool's tagged default and record `attention`.

#### Scenario: Confident choice is applied

- **WHEN** a single-select answer names a pool entry with `confidence` of at least 0.5
- **THEN** that entry's profile SHALL be applied to the step's routes

#### Scenario: Low-confidence answer falls back

- **WHEN** a single-select answer has `confidence` below 0.5
- **THEN** the pool's `default: true` entry SHALL be applied
- **AND** the workflow SHALL record `attention`

### Requirement: Fusion roster probability selection

For the `roster` question the classifier SHALL sort the answer's `probabilities`
descending, keep every entry with `probability` of at least 0.2, de-duplicate
profiles, and clamp the result to between two and five entries. If fewer than
two distinct profiles remain, the pool's tagged defaults SHALL be used and the
workflow SHALL record `attention`. A roster that is empty or duplicate-only
SHALL never strand the run.

#### Scenario: Threshold, de-duplication, and clamp

- **WHEN** the roster answer contains probabilities at or above and below 0.2, a repeated profile, and more than five survivors
- **THEN** the router SHALL keep only entries at or above 0.2, remove duplicates, and clamp to at most five
- **AND** the selected roster SHALL contain distinct profiles

#### Scenario: Roster collapses below two profiles

- **WHEN** thresholding and de-duplication leave fewer than two distinct profiles
- **THEN** the pool's tagged defaults SHALL be used
- **AND** the workflow SHALL record `attention`

### Requirement: Atomic routing update with default fallback

A routing pass SHALL apply every single selection and, for a roster, recompute
the fusion roles for the selected count, override the planner-K profiles,
validate the resulting fusion routing, preflight each profile, and enforce
read-only steps. Applying a single selection SHALL replace every route for that
step so one verification pool covers all verifier roles. Any failure SHALL keep
the tagged defaults, record `attention`, and leave the workflow runnable rather
than stranding it.

#### Scenario: All routes for a selected step are replaced

- **WHEN** the classifier selects a profile for `core.verification` and the routing has several verifier-role routes
- **THEN** every `core.verification` route SHALL use the selected profile

#### Scenario: Fusion roster recomputes the fan-out

- **WHEN** the roster selects N distinct profiles
- **THEN** the router SHALL recompute `planner-1` through `planner-N`, apply the selected profiles, and validate the fusion routing before the workflow continues

#### Scenario: Routing update fails

- **WHEN** applying a selection fails validation, preflight, or read-only enforcement
- **THEN** the previously pinned default routing SHALL remain in place
- **AND** the workflow SHALL record `attention` instead of failing the run

### Requirement: Classifier coverage validation

At workflow start and at preset switch the system SHALL verify that every
classifiable step present in the resolved definition has a valid pool in the
effective preset. A classifier-routed workflow started with no preset SHALL
fail before any agent launches, and every coverage or missing-preset failure
SHALL point at Settings → Presets.

#### Scenario: Start validates pool coverage

- **WHEN** a workflow whose resolved definition contains a classifiable step starts with a preset lacking that step's pool
- **THEN** startup SHALL fail before launching any agent
- **AND** the error SHALL point at Settings → Presets

#### Scenario: Preset switch validates pool coverage

- **WHEN** an active workflow switches to a preset lacking a pool for a classifiable step in its resolved definition
- **THEN** the switch SHALL be rejected with the Settings → Presets hint
- **AND** the previously pinned routing SHALL remain in effect

#### Scenario: Classifier workflow starts without a preset

- **WHEN** a classifier-routed workflow is started without a selected preset
- **THEN** startup SHALL fail before any agent launches with the Settings → Presets hint
