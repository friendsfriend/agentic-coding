## ADDED Requirements

### Requirement: A developer wait is a projection of the state that causes it

The system SHALL report a workflow's developer wait as a projection of state it
already has, never as stored state: the wait SHALL be derived from the workflow's
status, its dialogue records, its run rows and the actor of its current step, and
SHALL NOT be written to the store, to a snapshot or to an effect. A wait SHALL
name its kind — `question`, `handoff` or `approval` — the id of the subject that
causes it, and the instant it started, and SHALL be absent while the workflow is
completed or closed. Precedence SHALL be question over handoff over approval: a
workflow whose developer owes an answer waits on that answer, whatever else it has
handed over at the same time, and the oldest open question SHALL be the subject.
A question the developer owes an answer for SHALL be a record that is pending and
not routed to a peer agent, so a new question kind — a login handoff among them —
SHALL be covered without naming it, and a record the developer may not answer
SHALL NOT be a wait.

#### Scenario: Each blocking kind opens its own wait

- **WHEN** a workflow's developer is asked a question, a run of the workflow is
  blocked, or the workflow enters a step whose actor is the developer
- **THEN** the workflow's wait SHALL name `question`, `handoff` or `approval`
  respectively, with the question id, the blocked run id or the step id as its
  subject, and the instant the blocking state began
- **AND** a workflow that is waiting for nothing SHALL report no wait

#### Scenario: The wait follows the state, not the clock

- **WHEN** a question is pending in the store but has passed its durable expiry
- **THEN** it SHALL still be the developer's wait, because the expiry the engine
  records is what ends it and the clock alone ends no wait
- **AND** a question that is answered, expired or cancelled SHALL NOT be a wait

#### Scenario: A completed workflow waits for nobody

- **WHEN** a workflow that was waiting on a developer reaches `completed` or
  `closed`
- **THEN** it SHALL report no wait, so a wait left open by a killed run is
  treated as ended at the close

### Requirement: The event stream reports where agent time stops and human time starts

The system SHALL emit `workflow.waiting` when a workflow enters a developer wait,
`workflow.waiting.ended` when it leaves one, and SHALL emit nothing when a wait is
unchanged: a poll, a read, a re-entered approval gate and a repeated observation
of the same wait SHALL each emit no event. Both events SHALL carry the wait's
kind, its subject id, the step the workflow was on, and — on the start event — the
instant the wait began; the end event SHALL additionally carry the elapsed seconds
when the start is known. A wait whose subject changes SHALL end and start in that
order, so a reader pairing the two never sees two open waits, and a wait that has
started SHALL always have an end: a wait left open when the workflow completes or
closes SHALL end at that transition. Both events SHALL be part of the versioned
event catalog with a schema for their payload, and SHALL NOT be human-needed: the
obligation itself already notifies. The recorded pair SHALL reach the append-only
dataset, and the `developer-waits` query SHALL report agent seconds and human wait
seconds as two numbers per workflow, preferring the recorded waits and falling
back to the question records only where no wait was recorded.

#### Scenario: Entering a wait is one event

- **WHEN** a workflow asks its developer a question, or a run of the workflow
  hands off as blocked, or the workflow enters a developer-actor step
- **THEN** the stream SHALL report one `workflow.waiting` naming that kind and
  subject
- **AND** a further observation of the unchanged wait SHALL report nothing

#### Scenario: Leaving a wait is one event with the elapsed time

- **WHEN** the developer answers the question, the blocked run is resolved, or the
  gate is acted on
- **THEN** the stream SHALL report one `workflow.waiting.ended` naming that kind
  and subject, with the seconds the wait stayed open

#### Scenario: An open wait ends at the close

- **WHEN** a workflow whose wait is still open completes or closes
- **THEN** the stream SHALL report `workflow.waiting.ended` at that transition
- **AND** the dataset SHALL show one end for every start it recorded

#### Scenario: Agent time and human wait are two numbers

- **WHEN** the `developer-waits` query is run over an imported dataset
- **THEN** it SHALL report, per workflow and source, the agent seconds and the
  human wait seconds as separate columns, counting the recorded waits when there
  are any and reconstructing the question waits when there are none
