# workflow-archive-execution Specification

## Purpose
TBD - created by archiving change correct-archive-effect-counterfactual. Update Purpose after archive.
## Requirements
### Requirement: The archive happy path is executed by the archive role, not an engine effect

The engine SHALL execute the archive happy path — `openspec validate
"$HERDR_CHANGE_ID" --strict`, `openspec archive "$HERDR_CHANGE_ID" --yes` and
`openspec validate --all` — exclusively inside the run of the registered `archive`
role. The effect catalog SHALL NOT declare an archive effect: the `EffectKind`
union SHALL NOT contain an archive kind, the effect runner SHALL NOT register an
archive handler, and the engine SHALL NOT spawn `openspec archive` from engine
code. `core.archive` SHALL remain an agent step declaring `roles: () =>
["archive"]`.

This requirement records a measured fact, not a new behavior: the spike for
efficiency backlog item 22 established that no era of the engine ever executed
those commands (see `docs/efficiency/02i-archive-effect-counterfactual.md`).

#### Scenario: No archive effect exists in the catalog

- **WHEN** the `EffectKind` union and the effect runner's handler registry are
  inspected
- **THEN** neither SHALL contain an archive effect kind
- **AND** the only delivery effects SHALL remain commit and push

#### Scenario: The archive commands run only inside the archive role's run

- **WHEN** a workflow archives a change
- **THEN** `openspec validate --strict` and `openspec archive --yes` SHALL run in
  the `archive` role's run, driven by that run's assignment
- **AND** the engine SHALL NOT spawn them itself

#### Scenario: The step declares the archive role

- **WHEN** the `core.archive` step behavior is read
- **THEN** its `roles` SHALL be exactly `["archive"]`
- **AND** its `candidateRoles` SHALL be exactly `["archive"]`

#### Scenario: The failure path keeps the bounded repair loop

- **WHEN** an archive attempt fails
- **THEN** the workflow SHALL keep the bounded repair loop the archive step already
  declares, with the existing attempt limit and no new effect
- **AND** the archive happy path SHALL remain unchanged by this requirement

### Requirement: A claim that the engine used to perform a step needs a source emitter

An efficiency analysis SHALL NOT record, as verified, that the engine once
performed work in an effect unless git history contains a source site that emits
that work's start event and then spawns it. When no such site exists, the claim
SHALL be recorded as refuted, with the emitting sites identified, and the backlog
item that depended on it SHALL be marked stopped rather than implemented.

#### Scenario: A bracketing event pair is attributed to its emitter

- **WHEN** an analysis observes a start/complete event pair with no token cost
  attached and no emitter in the current source
- **THEN** it SHALL locate the emitting site for both events in git history before
  concluding that an engine effect performed the work
- **AND** it SHALL attribute the window to the run those emitters bracket

#### Scenario: A refuted counterfactual stops the item

- **WHEN** the emitting sites show that the start event follows a role launch and
  the complete event is emitted by a verb that role itself invokes
- **THEN** the counterfactual SHALL be recorded as refuted in the item's design
  document
- **AND** the item's implementation SHALL stop at its own spike gate

#### Scenario: The refutation is recorded where the next reader looks

- **WHEN** the counterfactual is refuted
- **THEN** an addendum SHALL record the evidence, the reproducing queries and the
  verdict
- **AND** the upstream analysis and backlog item SHALL carry a pointer to it
  without rewriting their existing figures

