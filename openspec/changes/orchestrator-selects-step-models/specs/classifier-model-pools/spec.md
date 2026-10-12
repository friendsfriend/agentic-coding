## RENAMED Requirements

- FROM: `### Requirement: Classifiable step mode metadata`
- TO: `### Requirement: Pool-bearing step metadata`

## MODIFIED Requirements

### Requirement: Per-step model pools

A custom agent preset SHALL define its step models as `pools`: a table keyed by
pool-bearing step id whose value is the single profile that runs that step, or,
for a pool whose step declares the `roster` mode, an ordered list of profile
names. A single-model pool SHALL name exactly one existing profile; a roster
pool SHALL name between two and five distinct existing profiles. A pool value
that is not a string, a roster value that is not a list, a value naming an
unknown profile, a roster of the wrong size, or a roster repeating a profile
SHALL be a hard configuration error whose message names the provenance file,
the preset, the step, and the offending value, and points at Settings →
Presets. A legacy pool written as a list of labelled entries SHALL still parse:
it SHALL be normalized by keeping the entry tagged `default: true` for a
single-model pool and the tagged defaults for a roster pool, so a configuration
that has not been converted and a workflow already pinned to an older
definition keep resolving.

#### Scenario: Valid single-model pool

- **WHEN** a preset declares a pool-bearing step with one existing profile name
- **THEN** the preset SHALL parse and the pool SHALL be usable as that step's model

#### Scenario: Valid roster pool

- **WHEN** a preset declares the roster step with two to five distinct existing profile names
- **THEN** the preset SHALL parse and the list SHALL be usable as the planner roster

#### Scenario: Pool shape is violated

- **WHEN** a pool names an unknown profile, a roster holds fewer than two or more than five entries, a roster repeats a profile, or a non-roster pool carries a list
- **THEN** configuration parsing SHALL fail and identify the preset, the step, and the violating value

#### Scenario: Legacy list-shaped pool is normalized

- **WHEN** a preset declares a pool as an ordered list of labelled entries, one of them tagged `default: true`
- **THEN** the normalized pool SHALL be that entry's profile
- **AND** the preset SHALL be usable without a configuration rewrite

#### Scenario: Legacy entry metadata is dropped

- **WHEN** a legacy pool entry carries a `label`, `criteria`, or `default` field
- **THEN** the normalized pool SHALL carry only the profile
- **AND** no field of the entry SHALL be carried into any workflow state

### Requirement: Pool-bearing step metadata

The workflow SHALL declare a pool mode for each step that has a model pool:
`single` for `core.plan`, `fusion.consolidate`, `core.implementation`,
`core.triage`, `core.verification`, `core.wiki`, `core.archive`, `core.rebase`,
and `core.research`; `roster` for `fusion.plan`. The registered step behavior
SHALL be the only source of that declaration, so the config key set and the
step's own knowledge cannot drift, and every other step SHALL have no pool key.
All verifier roles of `core.verification` SHALL share that step's single pool.
Classifier integrations that resolve no model pool SHALL be distinct from this
metadata: they SHALL be asked through their own integration identifier, SHALL
NOT consume a pool, and SHALL NOT make a step pool-bearing.

#### Scenario: Only pool-bearing steps have a pool key

- **WHEN** the pool key set is derived
- **THEN** it SHALL contain exactly the steps whose registered behavior declares a pool mode
- **AND** a step that declares no mode SHALL have no pool key

#### Scenario: Verifier roles share one pool

- **WHEN** triage selects several verifier roles for a round
- **THEN** every selected verifier role SHALL resolve through the one profile the `core.verification` pool names

#### Scenario: A non-pool integration asks the classifier

- **WHEN** a classifier integration that resolves no model pool is invoked
- **THEN** no pool SHALL be read for it
- **AND** the pinned model routing SHALL be left unchanged

## REMOVED Requirements

### Requirement: Two-pass classifier routing

**Reason**: No decision model selects a model any more; a workflow's per-step
models are pinned at start, so there is no routing pass to run before planning
or after plan approval.

**Migration**: Read the per-step models from the workflow's pinned metadata or
from the preset's `pools` (spec: `orchestrator-step-model-selection`). A
workflow already pinned to a definition tier that carries route steps keeps
running: its route steps complete without a classifier call and keep the routing
already pinned.

### Requirement: Fusion roster probability selection

**Reason**: The fusion roster is no longer derived from a classifier's
probabilities; it is the list the Orchestrator named or the preset declares.

**Migration**: Name the roster in the start's per-step model selection, or set
the preset's roster pool to the two-to-five profiles that should plan in
parallel. The threshold, de-duplication, and clamp rules are retired with the
classifier answer they read.

### Requirement: Atomic routing update with default fallback

**Reason**: There is no mid-run routing update to make atomic, and no tagged
default to fall back to: the model of every step is resolved and validated once
at start.

**Migration**: A start that cannot resolve a step's model falls back through the
preset and configured routes as specified by
`orchestrator-step-model-selection`; a fusion start without a usable roster
fails before any agent launches instead of recording attention.

### Requirement: Classifier coverage validation

**Reason**: Coverage existed so a routing pass had a pool to ask about. Without
routing, a preset that declares no pool for a step is a partial preset, not a
configuration error: the step resolves through the fallback chain.

**Migration**: Delete the `Settings → Presets` coverage failure from any
tooling that relied on it. A workflow no longer requires a preset at all; only a
fusion start requires a planner roster.

### Requirement: System One answer shapes

**Reason**: The router was the only consumer of a `choice` answer with
probabilities; the remaining classifier integrations ask `noul` necessity
questions.

**Migration**: Parse and use the necessity answer as the remaining
integrations already do. A `choice` answer left in an older stored record stays
readable; nothing new produces one.

### Requirement: Single-select choice uses the classifier's most probable entry

**Reason**: No classifier chooses among pool entries, so the choice, confidence,
and probability rules that picked one are dead.

**Migration**: A step's model is the profile its pool names, or the one the
Orchestrator named at start. Confidence and probability are no longer consulted
anywhere in model selection.
