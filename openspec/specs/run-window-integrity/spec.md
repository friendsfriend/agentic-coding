# run-window-integrity Specification

## Purpose
TBD - created by archiving change record-session-window-drift. Update Purpose after archive.
## Requirements
### Requirement: A run's window and its session's window are reported separately

The efficiency dataset SHALL expose, per run, the run window the engine recorded
and the tail its session produced past it, and SHALL classify every tail rather
than only measuring it. The `run-window-drift` query SHALL keep its existing
columns — the run and workflow identity, the role and status, the recorded start
and completion, the turn count, the first and last turn, and the tail in seconds
for any tail longer than one minute — and SHALL add the number of turns that
started after the run's recorded completion, whether one of the run's own session
window rows falls at or after that completion, the run's own latest binding reason
and the run its latest `closed` row names, and a `drift_kind` decided in this
order: `clock-artifact` (the recorded completion is not after the recorded start,
so the run's own window cannot be read), `attributed` (a `closed` row names this
run, i.e. the recording states that its session continued under a later run),
`resumed` (no `closed`, but the recording binds the run's own conversation to it
at or after its completion, or with the reason `resumed`) or `unexplained`
(neither, whether or not some row names the run). A run whose turns all start
before its recorded completion SHALL NOT appear.

#### Scenario: A tail the recording explains by a rebinding

- **WHEN** a run's turns continue after its recorded completion and the recording
  carries `runtime.session_window.closed` for it
- **THEN** the query SHALL report the run with `drift_kind` `attributed`, its
  tail in seconds, and the number of its turns that started after completion

#### Scenario: A tail the recording explains by the run's own binding

- **WHEN** a run's turns continue after its recorded completion, the recording
  carries no `closed` row for it, and one of its own `opened` rows falls at or
  after that completion, or carries the reason `resumed`
- **THEN** the query SHALL report the run with `drift_kind` `resumed`
- **AND** it SHALL report the reason of the run's latest binding, not the
  lexicographically greatest reason it has ever carried

#### Scenario: A binding that predates the run's completion

- **WHEN** a run's turns continue after its recorded completion and the only row
  naming it is an `opened` row from before that completion, with no `closed` row
- **THEN** the query SHALL report the run with `drift_kind` `unexplained`

#### Scenario: A window that cannot be read

- **WHEN** a run's recorded completion is not after its recorded start and its
  turns continue past that completion
- **THEN** the query SHALL report the run with `drift_kind` `clock-artifact`

#### Scenario: A tail nothing explains

- **WHEN** a run's turns continue after its recorded completion and neither a
  session-window record that states a continuation nor an unreadable window
  applies
- **THEN** the query SHALL report the run with `drift_kind` `unexplained`

#### Scenario: A run inside its own window

- **WHEN** every turn of a run starts before its recorded completion
- **THEN** the query SHALL NOT report the run

### Requirement: The dataset build refuses a run-window tail no record explains

The dataset build SHALL fail rather than write a dataset in which a drifting run
is `unexplained` while its own record was due. The record has been due since the
run's workflow recorded its first session-window row: a run that started at or
after that event and is still `unexplained` SHALL fail the build, because the
record should have named a continuation for it. The build SHALL run the
run-window query against the dataset it just wrote, delete that dataset and its
README on failure, name the offending runs and workflows with the query to
inspect them, and exit non-zero.

Nothing else SHALL fail the build. A run that started before its workflow's first
session-window event SHALL be counted and reported as `unrecorded` with
`beforeRecord`; so SHALL a run whose own window cannot be read, reported under
`clockArtifact`. The rows the record explains SHALL be reported as `judged`, with
the `attributed` and `resumed` counts, and the `unexplained` count SHALL equal
the `unrecorded` rows. The build SHALL report those populations — `drifting`,
`judged`, `unrecorded`, `clockArtifact`, `unexplained` and the workflows that
recorded a window — in its own summary, so a generation this record cannot speak
about is visible rather than silently passing.

#### Scenario: A run whose record was due has none

- **WHEN** a build writes a dataset in which a workflow recorded a session window
  and a run that started after that record carries turns after its recorded
  completion with nothing in the recording that states a continuation
- **THEN** the build SHALL fail with a non-zero status
- **AND** it SHALL remove the dataset and its README and name the run, its
  workflow and the query that reports it

#### Scenario: A run that predates the record

- **WHEN** a build writes a dataset in which a drifting run started before its
  workflow's first session-window event and the recording states no continuation
  for it
- **THEN** the build SHALL succeed
- **AND** it SHALL report the run under `unrecorded.beforeRecord`

#### Scenario: A generation that predates the record

- **WHEN** a build writes a dataset whose workflows carry no session-window event
  at all
- **THEN** the build SHALL succeed
- **AND** it SHALL report every drifting run as unrecorded in its summary

#### Scenario: A tail the recording explains passes

- **WHEN** every drifting run whose record was due carries either a `closed` row
  or a binding of its own at or after its completion
- **THEN** the build SHALL succeed and report those runs as `judged`

#### Scenario: An unreadable window passes

- **WHEN** a drifting run's recorded completion is not after its recorded start
- **THEN** the build SHALL succeed and report the run as clock-artifact

#### Scenario: A dataset file another build wrote

- **WHEN** a reader is pointed at a dataset file whose recorded schema version is
  not the one this build writes
- **THEN** it SHALL refuse the file, naming both versions and the command that
  rebuilds it, and SHALL NOT read or modify it

