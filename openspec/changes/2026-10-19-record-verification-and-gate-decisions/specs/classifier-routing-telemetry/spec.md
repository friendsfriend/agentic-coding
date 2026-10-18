## ADDED Requirements

### Requirement: Every verification round exports one decision record

The system SHALL export exactly one `verification_round` event on the engine
telemetry layer for every verification round that ends, and no event for a round
that is still open or that the verification gate skipped. The event SHALL report
the round index, the round's outcome (`findings` when a critical finding was
handed over, `none` when the round found nothing, `abandoned` when a verifier run
failed and the round ended without a verdict), the run ids and roles that took
part, the number of participating runs, the summed critical count, the role
selection the round was locked to, and the round's planned file→role map as
counts plus a digest. A round whose own completion is deferred — a sibling run
still in flight, or the engine-owned full suite not yet dispatched — SHALL export
nothing, so one round has exactly one record.

#### Scenario: A round with critical findings is recorded as found something

- **WHEN** a round's verifier hands over one critical finding and the round ends
  on a fix
- **THEN** the `verification_round` event SHALL report that round's index, the
  outcome `findings`, the participating roles, the run count, and the critical
  count
- **AND** it SHALL report the role selection the round was locked to

#### Scenario: A round that found nothing still records one event

- **WHEN** every verifier of a round hands over no finding and the engine-owned
  full suite has run
- **THEN** the round SHALL export exactly one `verification_round` event with the
  outcome `none`
- **AND** the deferred handoff that dispatched the engine-owned suite SHALL have
  exported no event of its own

#### Scenario: A round abandoned by a failed verifier is recorded

- **WHEN** a verifier run ends `failed` and its siblings are expired so the round
  ends without a verdict
- **THEN** the round SHALL export exactly one `verification_round` event with the
  outcome `abandoned`, the round's index, and the runs and roles the round still
  held

#### Scenario: A skipped round exports no round record

- **WHEN** the verification gate answers `skip` and the round's stages never run
- **THEN** no `verification_round` event SHALL be exported for that round
- **AND** the gate's own decision record SHALL be the whole record of the
  evaluation

### Requirement: Every triage selection names the path that produced it

The system SHALL export exactly one `triage.plan.selected` event on the engine
telemetry layer per round that reaches a role selection. The event SHALL report
the round index, the selected roles and their count, the planned file→role map as
counts plus a digest, the number of files in the round's changed scope, and the
path that produced the selection: `classifier` when the round's classification
selected the roles, `default` when the graph asks and the classification came
back without a role constraint, `legacy-agent` when the definition predates the
routing step so the triage agent has always chosen, and `empty-bypass` for a real
zero-role verdict that bypasses triage entirely. The zero-role verdict SHALL be
recorded by the routing step that decided it, because no triage run follows it. A
field the engine does not hold at that boundary SHALL be omitted rather than
reported as a placeholder.

#### Scenario: A classifier selection is attributed to the classifier

- **WHEN** the round's classification selects verifier roles and the triage agent
  narrows them into a plan
- **THEN** the `triage.plan.selected` event SHALL report the source `classifier`,
  the round's index, the planned roles, and the plan's file→role counts and
  digest

#### Scenario: A fail-open classification is attributed to the agent

- **WHEN** the round's classification fails open and the triage agent's own plan
  becomes the round's role set
- **THEN** the `triage.plan.selected` event SHALL report the source `default`
- **AND** the fail-open result SHALL carry no gate verdict, so no gate decision
  SHALL be recorded for it

#### Scenario: A definition without the routing step is attributed to the agent

- **WHEN** a definition that predates `core.triage-route` completes its triage
  step
- **THEN** the `triage.plan.selected` event SHALL report the source `legacy-agent`

#### Scenario: A zero-role verdict records the bypass

- **WHEN** the round's classification returns a real selection of no roles
- **THEN** the `triage.plan.selected` event SHALL report the source
  `empty-bypass` and a role count of zero
- **AND** triage SHALL NOT run for that round

### Requirement: Every gate evaluation exports one decision record

The system SHALL export one `gate.decision` event on the engine telemetry layer
per gate evaluation, whether the guarded stage ran or was skipped. The event
SHALL report the guarded stage, the decision (`run` or `skip`), the resolved
policy (`auto` or `always`), whether the decision was forced or answered, and the
classifier's `noul` answer when one was produced, and SHALL carry the measured
duration of the classification call that decided it as its latency. The existing
`gate.skip` event SHALL keep its current shape and SHALL still fire on an actual
skip. A gate evaluation that never reached a verdict SHALL export no decision
record.

#### Scenario: Both a run and a skip are recorded as decisions

- **WHEN** one gate answers `run` and another answers `skip`
- **THEN** each SHALL export one `gate.decision` event naming its stage,
  decision, and resolved policy
- **AND** the skipped stage SHALL still export its `gate.skip` event

#### Scenario: The evaluation's latency is the classification's duration

- **WHEN** the classification call that decides a gate reports a measured
  duration
- **THEN** the `gate.decision` event SHALL carry that duration
- **AND** WHEN no duration was measured, the event SHALL omit it rather than
  report zero

### Requirement: Decision records are bounded and content-free

The decision events SHALL NOT export file contents, file lists, task text,
artifact bodies, or credentials. A round's plan SHALL travel as one count per
role, a total file count, and one digest of the sorted `role:path` lines, so the
record's size SHALL NOT grow with the size of the change set. Every value SHALL be
a string, number, or boolean bounded by the shared telemetry attribute limit, and
every exported string SHALL have known credential shapes redacted before it is
written. Emitting a decision record SHALL NOT change the classification result,
the selected roles, any gate verdict, or any workflow transition.

#### Scenario: A large plan stays a count and a digest

- **WHEN** a round plans a change set of many hundreds of files
- **THEN** the `triage.plan.selected` and `verification_round` events SHALL
  report the file count, one `role=count` per role, and one digest
- **AND** no file path from the plan SHALL appear in any exported value

#### Scenario: A decision record never changes the decision

- **WHEN** writing or exporting a decision record fails
- **THEN** the round's selections, the round's outcome, and the gate's verdict
  SHALL be exactly what they would have been without it
