# Spec Delta

## Purpose

Make a developer-initiated abort an explicit workflow outcome instead of a run
left waiting for a turn that will never arrive.

## ADDED Requirements

### Requirement: A developer abort is recorded as a blocked handoff

When the developer aborts a managed run from the dashboard or orchestrator session, the durable host SHALL record that run's `blocked` outcome with a bounded message naming the abort, before the run's turn is torn down. The handoff SHALL use the run's own launch-bound capability and SHALL be best-effort: a run that already handed off, or a handoff the engine rejects, SHALL leave the workflow unchanged and SHALL NOT fail the abort. A host teardown that stops runs without a developer abort (workflow close, deletion, host shutdown) SHALL NOT record a blocked handoff.

#### Scenario: Developer aborts a working run

- **WHEN** the developer aborts a run whose conversation is mid-turn
- **THEN** the run's capability SHALL record `blocked` with a bounded abort message
- **AND** the workflow SHALL show the step as `attention-required` instead of leaving the run `working`

#### Scenario: Abort of a finished run

- **WHEN** the developer aborts a run that has already completed or handed off
- **THEN** the abort SHALL succeed
- **AND** the workflow's recorded state SHALL remain unchanged

#### Scenario: Teardown does not block a run

- **WHEN** the workflow closes, is deleted, or the host shuts down and stops its runs
- **THEN** no `blocked` handoff SHALL be recorded for those runs
