# classifier-routing-telemetry Specification

## Purpose
Makes the JEV/System One classifier routing that selects per-step model pools
observable: every routing pass exports a bounded, content-free decision record
and a provider-call record into the same OTEL/JSONL telemetry stream that
already carries the agent sessions, so a workflow's routing behaviour can be
reviewed, tuned, and debugged the way its sessions can.
## Requirements
### Requirement: Every completed classification pass exports one decision record

The system SHALL export exactly one `routing.classified` event per completed
classifier routing pass on the engine telemetry layer. The event SHALL identify
the workflow, the routing step that issued the pass, the pass phase (`plan` or
`apply`), and the effect id, and SHALL report, for every step the pass asked:
the label the classifier selected, the reported confidence, whether that step
fell back to a pool's tagged default, and the model profile(s) pinned for the
step by that pass. A step SHALL be reported as a fallback only when the pass
applied the tagged default because the answer carried no usable choice, so a
below-floor confidence that is applied is not a fallback. A field the classifier
or the pass did not produce SHALL be omitted rather than reported as a
placeholder, and the event SHALL report the pass's fallbacks as a count so a
silently defaulted pass is visible in one row.

#### Scenario: Single-selection pass records the applied profile

- **WHEN** a plan-phase pass asks `core.plan` and the classifier answers with the
  label `high-cost-smart`
- **THEN** the `routing.classified` event SHALL report step `core.plan` with that
  label, its reported confidence, no fallback, and the model profile pinned for
  `core.plan`
- **AND** the event SHALL report the phase `plan` and the pass's effect id

#### Scenario: Below-floor confidence is applied, not a fallback

- **WHEN** the classifier answers `core.plan` with a chosen label at a
  confidence below 0.5
- **THEN** the `routing.classified` event SHALL report that label and confidence
  and SHALL NOT mark `core.plan` as a fallback
- **AND** it SHALL report the profile the pass pinned from that answer

#### Scenario: Roster pass records the selected planner set

- **WHEN** a pass asks a roster step and the classifier's probabilities select
  three distinct planner profiles
- **THEN** the `routing.classified` event SHALL report that step's selected count
  of 3 and the profiles pinned for the roster roles

#### Scenario: Answer-free pass still exports a record

- **WHEN** a step's answer collapses to a `noul` answer because the provider
  returned no usable decision for it
- **THEN** the `routing.classified` event SHALL still report that step and its
  applied profile and fallback flag
- **AND** it SHALL omit the label and confidence it never received

#### Scenario: Pass that never completed exports no decision record

- **WHEN** the classifier call fails, times out, or the pass is retried
- **THEN** no `routing.classified` event SHALL be exported for that attempt
- **AND** the failure SHALL remain observable through the pass's provider-call
  response event

### Requirement: Every classifier call exports a bounded provider-call record

The system SHALL export one `routing.request` event when a classifier call is
sent and one `routing.response` event when it returns, on the adapter telemetry
layer, and both SHALL identify the classifier model, the pass phase, the number
of steps asked, the total number of pool entries offered, the number of
collected artifacts, and the size in bytes of the bounded state sent. The
response event SHALL report the measured call duration, the HTTP status of a
completed call, and the status class of that status.

#### Scenario: Successful call reports latency and status

- **WHEN** a pass's System One call returns HTTP 200 with a parseable answer
- **THEN** the `routing.response` event SHALL report an `ok` outcome, the HTTP
  status 200, its status class, and the measured duration of the call

#### Scenario: Reported usage is exported when present

- **WHEN** the provider response reports token or cost usage
- **THEN** the `routing.response` event SHALL export those numbers as numeric
  fields
- **AND** WHEN the response reports no usage, the event SHALL omit the usage
  fields rather than report zero

#### Scenario: Failed call exports status or failure class without answers

- **WHEN** the classifier call fails with a transport error, a timeout, or a
  non-2xx status
- **THEN** the `routing.response` event SHALL be exported with an `error`
  outcome and the failure's bounded error class, plus the HTTP status when one
  was received
- **AND** it SHALL NOT carry any classifier answer, label, or confidence

### Requirement: Routing events join the workflow trace and are attributable

Every routing event SHALL carry the layer, workflow id, step id, effect id, and a
W3C traceparent, so that the request, response, and decision records of one pass
resolve to the same workflow trace as the engine, adapter, and runtime events of
that workflow, and the three records of a pass share one effect id so a pass can
be inspected without time correlation. An identity field that cannot be resolved
SHALL be omitted rather than exported as a placeholder.

#### Scenario: The three records of one pass correlate by effect id

- **WHEN** a single classification pass completes
- **THEN** its `routing.request`, `routing.response`, and `routing.classified`
  events SHALL carry the same effect id
- **AND** all three SHALL resolve to the one trace id of the workflow

#### Scenario: Routing events join the agent session events of the run

- **WHEN** a workflow's telemetry stream contains routing events and pi runtime
  session events
- **THEN** a trace consumer grouping by trace id SHALL see them as spans of one
  workflow trace

### Requirement: Routing telemetry is bounded, content-free, and redacted

Routing telemetry SHALL NOT export the workflow task text, collected artifact
content, pool entry criteria, classifier answer text, prompts, or model output;
it SHALL export only scalar counts, sizes, statuses, confidences, labels, and
profiles. Every exported string SHALL have known credential shapes redacted
before it is written, and SHALL be bounded by the shared telemetry attribute
limit. A value that is not a string, number, or boolean SHALL be omitted.

#### Scenario: No prompt or artifact content reaches the stream

- **WHEN** a pass classifies a change whose planning artifacts contain source
  code and prose
- **THEN** the exported routing events SHALL contain the artifact count and byte
  sizes only
- **AND** no substring of the task text, the artifact content, the pool criteria,
  or the provider's answer text SHALL appear in the exported rows

#### Scenario: Credential-shaped values are redacted

- **WHEN** a reported label, profile name, or error class contains a
  credential-shaped value
- **THEN** the exported value SHALL be redacted before it is written to the
  telemetry stream

### Requirement: Routing telemetry is observational only

Emitting routing telemetry SHALL NOT change the classification result, the pool
selection a pass applies, or any workflow transition. A failure to build, bound,
redact, write, or export a routing payload SHALL be swallowed, and the pass
SHALL still apply its routing and the workflow SHALL remain runnable. Routing
telemetry SHALL NOT read or mutate workflow state, retry or re-issue a
classifier call, or switch a model or profile.

#### Scenario: Telemetry failure leaves the pass untouched

- **WHEN** writing or exporting a routing event fails during a pass
- **THEN** the pass SHALL still apply its selections and tagged defaults
- **AND** the workflow SHALL continue without an attention entry naming
  telemetry

#### Scenario: Telemetry never re-issues a call

- **WHEN** a pass's telemetry is emitted
- **THEN** no additional classifier call SHALL be made on the pass's behalf

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
selected the roles, `reverification` when the engine's re-verification scope
supplied the round's role set, `default` when the graph asks and the
classification came back without a role constraint, `legacy-agent` when the
definition predates the routing step so the triage agent has always chosen,
`empty-bypass` for a real zero-role classification verdict that bypasses triage
entirely, and `reverification-empty` for a zero-role verdict the re-verification
scope produced, which also bypasses triage. The zero-role verdicts SHALL be
recorded by the routing step that decided them, because no triage run follows
them. A field the engine does not hold at that boundary SHALL be omitted rather
than reported as a placeholder.

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
- **THEN** the `triage.plan.selected` event SHALL report the source
  `legacy-agent`

#### Scenario: A zero-role verdict records the bypass

- **WHEN** the round's classification returns a real selection of no roles
- **THEN** the `triage.plan.selected` event SHALL report the source
  `empty-bypass` and a role count of zero
- **AND** triage SHALL NOT run for that round

#### Scenario: An engine-scoped selection is attributed to the scope

- **WHEN** the engine's re-verification scope supplied the round's role set and
  the triage agent produced a plan from it
- **THEN** the `triage.plan.selected` event SHALL report the source
  `reverification` with the round's index and the plan's bounded file→role form
- **AND** the classifier's own role answers SHALL still be visible in the
  classification record for the same round

#### Scenario: A scope-produced zero-role verdict carries its own source

- **WHEN** the re-verification scope selects no role because the fix was below
  the minimum changed-file count and no eligible role reported the previous
  round's findings
- **THEN** the `triage.plan.selected` event SHALL report the source
  `reverification-empty` and a role count of zero
- **AND** it SHALL report the number of files the fix changed, because no triage
  step runs to report the round's change set
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

### Requirement: Every round that is scoped exports one scope decision record

The system SHALL export exactly one `verification_scope` event on the engine
telemetry layer for every round that reaches the routing step's role decision,
whether the round was scoped or widened. The event SHALL report the round index,
the mode (`first-round`, `scoped`, `suite-only`, or `full-set`), the reason from
a closed vocabulary, the minimum changed-file threshold in force, the number of
files the fix touched in content, the number of files it touched at all, the
number of files in the previous round's baseline, and one `role=reason` pair for
each role in the round's run set and in its skip set. The reason vocabulary SHALL
distinguish at least: no previous record, ownership of a touched file, a fix below
the minimum changed-file count, a role that reported the findings the fix
resolved, an unusable baseline, an unusable delta, a previous plan with no
ownership, a touched file that no plan role owned, a touched file that several
plan roles owned, and a reported role the definition can no longer launch. A
round that the routing step never reaches SHALL export no scope record. The
per-role reasons SHALL account for every eligible role in every mode the engine
decided, including the roles a classifier-decided round selected and skipped, so
a developer can read why each role did or did not run without the classifier
record.

#### Scenario: A scoped round names why each role runs or does not

- **WHEN** a round runs one role because it owns a touched file and skips the
  remaining eligible roles
- **THEN** the `verification_scope` event SHALL report the mode `scoped`, the
  reason that selected the run set, and one `role=reason` pair per running role
  and per skipped role

#### Scenario: A widened round says why it widened

- **WHEN** the engine cannot attribute the fix and leaves the round to the
  classifier
- **THEN** the `verification_scope` event SHALL report the mode `full-set` and the
  reason that widened the round

#### Scenario: A below-threshold round is recorded as such

- **WHEN** the fix is below the minimum changed-file count and the round opens no
  domain verifier
- **THEN** the `verification_scope` event SHALL report the mode `suite-only`, the
  reason for the below-threshold fix, and the threshold that was in force

#### Scenario: A first round is recorded as such

- **WHEN** no previous verification round has completed
- **THEN** the `verification_scope` event SHALL report the mode `first-round` and
  the reason that no previous record exists

#### Scenario: A round that re-runs reported roles names them as such

- **WHEN** a scoped round re-runs a role because it reported the previous round's
  finding and another because it owns a touched file
- **THEN** each role's `role=reason` pair SHALL name its own reason
- **AND** the event SHALL still report only counts, reasons, and role names

#### Scenario: A widened round names the reported role it cannot launch

- **WHEN** a reported role is outside the definition's eligible verifier roles
- **THEN** the `verification_scope` event SHALL report the mode `full-set` and the
  reason that names the reported role outside the catalog

#### Scenario: The scope record never carries a path or a body

- **WHEN** a round's fix touches hundreds of files
- **THEN** the `verification_scope` event SHALL report counts and one
  `role=reason` pair per role
- **AND** no file path, diff text, task text, or credential SHALL appear in any
  exported value

