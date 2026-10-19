## ADDED Requirements

### Requirement: The session window is recorded on a conversation's run binding

The runtime telemetry stream SHALL record a conversation's run bindings as
session-window events, distinct from the run window the engine records, so that a
session which continues after a run closed is stated rather than inferred. It
SHALL emit `runtime.session_window.opened` with the identity of the run now bound
to the conversation and a `herdr.session.reason` of `created` (the conversation
was created for this run), `rebound` (an existing conversation whose previous run
is known), `adopted` (an existing conversation whose previous run the host cannot
name, as after a host restart) or `resumed` (the conversation bound to the same
run again, as after an abort); on `rebound` it SHALL carry
`herdr.session.previous_run_id`. When the previous binding names a different run,
it SHALL emit `runtime.session_window.closed` with that run's identity and
`herdr.session.rebound_to` naming the run now bound, before the opened record.
Both events SHALL carry the conversation id as the envelope's session identity.
The events SHALL be additive and observational: they SHALL write no workflow
state, require no schema, snapshot or migration change, and SHALL NOT close a run
or a session.

#### Scenario: A session continues under a later run

- **WHEN** a conversation bound to one run is reused by a later run of the same
  step and role
- **THEN** the stream SHALL emit `runtime.session_window.closed` for the earlier
  run carrying the later run's id as `herdr.session.rebound_to`, then
  `runtime.session_window.opened` for the later run with reason `rebound` and
  `herdr.session.previous_run_id` naming the earlier run
- **AND** both events SHALL carry the conversation id as the session identity

#### Scenario: A new session names its reason

- **WHEN** a run receives a conversation created for it
- **THEN** the stream SHALL emit `runtime.session_window.opened` with reason
  `created` and no previous run id
- **AND** no `runtime.session_window.closed` SHALL be emitted for the
  conversation

#### Scenario: A resumed run reopens its own window

- **WHEN** an aborted run is resumed on its own conversation
- **THEN** the stream SHALL emit `runtime.session_window.opened` with reason
  `resumed` and the run's own id
- **AND** no `runtime.session_window.closed` SHALL be emitted for that run

#### Scenario: An adopted session states no previous run

- **WHEN** a conversation outlives the host that bound it and is reused by a run
- **THEN** the stream SHALL emit `runtime.session_window.opened` with reason
  `adopted` and no previous run id
- **AND** it SHALL emit no `runtime.session_window.closed`, because the host
  cannot name the run it cannot remember

#### Scenario: Recording a session window never changes a run

- **WHEN** a session-window event is emitted
- **THEN** the run's own recorded window, status and cost SHALL be unaffected
- **AND** a failed emission SHALL leave the run and the workflow unchanged
