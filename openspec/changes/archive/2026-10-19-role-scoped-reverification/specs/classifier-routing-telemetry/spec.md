## MODIFIED Requirements

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

## ADDED Requirements

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
