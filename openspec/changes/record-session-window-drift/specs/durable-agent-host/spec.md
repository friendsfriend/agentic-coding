## ADDED Requirements

### Requirement: A conversation's runtime telemetry identity follows the run it serves

The durable host SHALL resolve a conversation's runtime telemetry identity at
each emission rather than once at attachment, so that a conversation reused by a
later run attributes its events to the run that is active. The host SHALL keep
one binding per conversation — the run most recently bound to it — and SHALL
update that binding during `ensureRun` before the run's first submission. The
observers the host installs on the conversation's event stream that name a run
(the measured-context observer that feeds the cost ceiling and the finished-tool
observer that feeds the dead-surface rule) SHALL resolve the same binding, so a
run's ceiling and monitor decisions are recorded against the run that made them.
Rebinding SHALL be observational: it SHALL NOT change which conversation a run
uses, when a run is created, blocked, completed, expired or resumed, or any
durable state.

#### Scenario: A later round of the same role records its own turns

- **WHEN** a run of a step and role closes and a later run of the same step and
  role is served by the same conversation
- **THEN** every event the conversation publishes while the later run is the
  binding SHALL carry the later run's id in its run identity
- **AND** the earlier run SHALL retain only the events published while it was the
  binding

#### Scenario: The ceiling and the dead-surface monitor follow the active run

- **WHEN** a measured context or a finished tool call is observed on a
  conversation whose binding has moved to a later run
- **THEN** the cost-ceiling observation and the dead-surface observation SHALL be
  recorded for the run that is bound, not for the run that created the
  conversation

#### Scenario: A conversation with no run binding records nothing

- **WHEN** a conversation is ensured with no run identity in its environment, as
  an orchestrator session is
- **THEN** rebinding SHALL record no session-window event

#### Scenario: Rebinding does not change the run lifecycle

- **WHEN** a conversation is rebound to a run
- **THEN** the run's stored status, start, completion and capability hash SHALL be
  the same as they would be without the record
- **AND** a failure to attach or emit the record SHALL NOT fail the run
