## ADDED Requirements

### Requirement: A run's window and its session's window are reported separately

The efficiency dataset SHALL expose, per run, the run window the engine recorded
and the tail its session produced past it, and SHALL classify every tail rather
than only measuring it. The `run-window-drift` query SHALL keep its existing
columns — the run and workflow identity, the role and status, the recorded start
and completion, the turn count, the first and last turn, and the tail in seconds
for any tail longer than one minute — and SHALL add the number of turns that
started after the run's recorded completion and a `drift_kind` of `attributed`
(the recording states that this run's session continued under a later run),
`clock-artifact` (the recorded completion is not after the recorded start, so the
run's own window cannot be read) or `unexplained` (neither). A run whose turns
all start before its recorded completion SHALL NOT appear.

#### Scenario: A tail the recording explains

- **WHEN** a run's turns continue after its recorded completion and the run's
  workflow recorded `runtime.session_window.closed` for it
- **THEN** the query SHALL report the run with `drift_kind` `attributed`, its
  tail in seconds, and the number of its turns that started after completion

#### Scenario: A window that cannot be read

- **WHEN** a run's recorded completion is not after its recorded start and its
  turns continue past that completion
- **THEN** the query SHALL report the run with `drift_kind` `clock-artifact`

#### Scenario: A tail nothing explains

- **WHEN** a run's turns continue after its recorded completion and neither a
  session-window record for it nor an unreadable window applies
- **THEN** the query SHALL report the run with `drift_kind` `unexplained`

#### Scenario: A run inside its own window

- **WHEN** every turn of a run starts before its recorded completion
- **THEN** the query SHALL NOT report the run

### Requirement: The dataset build refuses an unexplained run-window tail

The dataset build SHALL fail rather than write a dataset that contains an
unexplained run-window tail for a workflow whose own recording states a session
window. It SHALL run the run-window query against the dataset it just wrote,
delete that dataset and its README on failure, name the offending runs and
workflows with the query to inspect them, and exit non-zero. A drifting run in a
workflow whose recording carries no session-window event SHALL be counted and
reported as unrecorded and SHALL NOT fail the build, and so SHALL an `attributed`
or `clock-artifact` row. The build SHALL report the judged, attributed,
clock-artifact, unexplained and unrecorded counts in its own summary, so a
generation this record cannot speak about is visible rather than silently
passing.

#### Scenario: A recorded workflow has an unexplained tail

- **WHEN** a build writes a dataset in which a workflow recorded a session window
  and one of its runs carries turns after its recorded completion with no
  session-window record of its own
- **THEN** the build SHALL fail with a non-zero status
- **AND** it SHALL remove the dataset and its README and name the run, its
  workflow and the query that reports it

#### Scenario: A generation that predates the record

- **WHEN** a build writes a dataset whose workflows carry no session-window event
  at all
- **THEN** the build SHALL succeed
- **AND** it SHALL report every drifting run as unrecorded in its summary

#### Scenario: A tail the recording explains passes

- **WHEN** every drifting run of a recorded workflow carries a session-window
  record for its tail
- **THEN** the build SHALL succeed and report those runs as attributed

#### Scenario: An unreadable window passes

- **WHEN** a drifting run's recorded completion is not after its recorded start
- **THEN** the build SHALL succeed and report the run as clock-artifact
