## ADDED Requirements

### Requirement: A conversation's runtime telemetry identity follows the run it serves

The durable host SHALL resolve a conversation's runtime telemetry identity at
each emission rather than once at attachment, so that a conversation reused by a
later run attributes its events to the run that is active. The host SHALL keep
one binding per conversation — the run most recently bound to it — and SHALL
update that binding during `ensureRun` before the run's first submission. The
observers the host installs on the conversation's event stream that name a run
SHALL resolve the run that produced the observation, not whichever run the binding
names when it is delivered: the measured-context observer that feeds the cost
ceiling SHALL charge the run whose message carried the measurement, and the
finished-tool observer that feeds the dead-surface rule SHALL charge the run that
started the call, ignoring an observation for a run the host no longer tracks. A
dead-surface decision SHALL be acted on with the failing run's own context and
SHALL be refused — recorded as an observation of a rebound owner, with no abort
and no handoff — when a later run now holds the conversation. Rebinding SHALL be
observational: it SHALL NOT change which conversation a run uses, when a run is
created, blocked, completed, expired or resumed, or any durable state. The
session window's own transition (reading the previous binding, draining the
stream, writing the new one) SHALL be serialized per conversation, so two
overlapping rebindings cannot close one run twice or leave the last run open.

#### Scenario: A later round of the same role records its own turns

- **WHEN** a run of a step and role closes and a later run of the same step and
  role is served by the same conversation
- **THEN** every event the conversation publishes while the later run is the
  binding SHALL carry the later run's id in its run identity
- **AND** the earlier run SHALL retain only the events published while it was the
  binding

#### Scenario: The ceiling follows the run that produced the measurement

- **WHEN** a measured context is observed on a conversation whose binding has
  moved to a later run
- **THEN** the cost-ceiling observation SHALL be recorded for the run whose
  message carried the measurement, not for the run that created the conversation
  and not for whichever run is bound when it is delivered

#### Scenario: A late failure of a retired run does not stop the run now bound

- **WHEN** a tool call started by one run finishes after another run has been
  bound to the same conversation
- **THEN** the dead-surface observation SHALL be charged to the run that started
  the call
- **AND** a decision it produces SHALL NOT abort the conversation, hand off or
  otherwise act on the run now bound

#### Scenario: Two rebindings of one conversation do not interleave

- **WHEN** a conversation is rebound twice before the first rebinding has recorded
  its window
- **THEN** each run that was left SHALL be closed exactly once, naming the run
  that followed it, and no run SHALL be left unclosed

#### Scenario: A conversation with no run binding records nothing

- **WHEN** a conversation is ensured with no run identity in its environment, as
  an orchestrator session is
- **THEN** rebinding SHALL record no session-window event

#### Scenario: Rebinding does not change the run lifecycle

- **WHEN** a conversation is rebound to a run
- **THEN** the run's stored status, start, completion and capability hash SHALL be
  the same as they would be without the record
- **AND** a failure to attach or emit the record SHALL NOT fail the run
