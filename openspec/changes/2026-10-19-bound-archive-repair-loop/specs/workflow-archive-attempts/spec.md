## ADDED Requirements

### Requirement: One archive entry gets at most two validate/archive attempts

The engine SHALL grant the archive step at most two `openspec validate`/`openspec archive` attempts per archive entry: the entry itself and one structural repair round. One attempt SHALL be one `openspec validate "$HERDR_CHANGE_ID" --strict` plus one `openspec archive "$HERDR_CHANGE_ID" --yes` pair. The step's rendered assignment SHALL state which attempt the run owns and what that attempt may do. The attempt number SHALL be step-local engine state, and no snapshot schema version change, migration, or compatibility reader SHALL be introduced for it.

#### Scenario: A failed first attempt grants the one repair round

- **WHEN** the archive run's first attempt fails and it hands off `blocked` with the validator output
- **THEN** the engine SHALL re-enter the archive step for a second attempt
- **AND** the second attempt's assignment SHALL state that it is attempt 2 of 2 and that it is the structural repair attempt

#### Scenario: The second failure parks the workflow with no third attempt

- **WHEN** the archive run's second attempt fails and it hands off `blocked`
- **THEN** the workflow SHALL end that handoff `attention-required` on the archive step
- **AND** the engine SHALL launch no third archive run for that entry

#### Scenario: The first attempt repairs nothing

- **WHEN** the archive step's assignment is rendered for attempt 1
- **THEN** it SHALL state that the run executes the command pair exactly once and does not edit the change documents on that attempt

#### Scenario: The repair attempt is limited to structural fixes

- **WHEN** the archive step's assignment is rendered for attempt 2
- **THEN** it SHALL state that the run reproduces the failure with `openspec validate --strict`, fixes only missing `## MODIFIED Requirements`/`## REMOVED Requirements` merge markers against the approved proposal, and hands off `blocked` with the exact validator output when the failure is not structural

### Requirement: The parked archive detail is the run's own validator output, redacted

When a `blocked` handoff with no completion parks a workflow, the engine SHALL use the run's own message as the `attention` detail, with known credential shapes redacted before the text is persisted. The engine SHALL NOT accept a detail beyond the handoff contract's own `message` bound, so no unredacted or unbounded transcript becomes persisted attention text. A granted repair round SHALL be reported as an `archive.repair_round` decision event naming the failed attempt, the next attempt and the limit.

#### Scenario: The parked detail carries the validator output

- **WHEN** the archive run's last allowed attempt hands off `blocked` with the validator output as its message
- **THEN** the parked workflow's `attention` detail SHALL contain that output

#### Scenario: Credential shapes in the detail are redacted

- **WHEN** that message contains a value matching a known credential shape
- **THEN** the persisted `attention` detail SHALL contain `[REDACTED]` in its place and SHALL NOT contain the value

#### Scenario: A detail beyond the handoff bound is refused, not persisted

- **WHEN** a handoff carries a `blocked` message larger than the contract's bound
- **THEN** the command SHALL be refused
- **AND** the archive attempt SHALL remain unspent and the workflow unparked

#### Scenario: A granted repair round is recorded

- **WHEN** an attempt with budget left fails
- **THEN** exactly one `archive.repair_round` decision event SHALL be exported for that attempt, with the failed attempt index, the next attempt index, and the limit

### Requirement: A developer repair grants a fresh pair of attempts

A step entry that the engine did not transition into — a developer `operator.repair` or a workflow resume, both of which re-enter the current step without an arrival — SHALL start a fresh pair of archive attempts. An entry the engine transitioned into (the graph entry, or the failed attempt's own self-loop) SHALL carry the attempt count forward.

#### Scenario: Repair after the budget is spent restores the pair

- **WHEN** a parked archive workflow is repaired back to the archive step
- **THEN** its attempt count SHALL be 1 and its `attention` SHALL be cleared
- **AND** the next failed attempt SHALL again grant a second attempt instead of parking immediately

#### Scenario: A transition arrival counts the attempt

- **WHEN** the engine transitions into the archive step from any other step
- **THEN** the attempt count SHALL be 1
- **AND** when the archive step's own `blocked` self-loop transitions into it, the count SHALL advance by one

### Requirement: The archive happy path is unchanged

An attempt that archives the change SHALL keep today's behavior: the run's `complete` handoff still passes the same archive-move evidence check and the same transition, the attempt budget is not consulted, and the graph's loop edges and the `failed` outcome's retry are unchanged.

#### Scenario: An archived change completes on its first pair

- **WHEN** the archive run moves the change into `openspec/changes/archive/` and hands off `complete`
- **THEN** the workflow SHALL advance exactly as before, with one archive run and an unspent first attempt

#### Scenario: A failed run keeps the retry it always had

- **WHEN** an archive run hands off `failed`
- **THEN** the workflow SHALL transition on the graph's existing `failed` loop edge, unchanged by the attempt budget
