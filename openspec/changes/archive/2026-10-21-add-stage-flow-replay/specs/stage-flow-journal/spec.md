## ADDED Requirements

### Requirement: Replay events enter the step journal through server ingestion
A replay process SHALL write ordered events to a replay event file and SHALL NOT append to `stage-journal.jsonl` directly. On a replay run, the server SHALL validate each event, apply the shared redactor, allocate the next journal sequence number, append the entry to `stage-journal.jsonl`, and record the flow id, plan id and revision, `inputsHash`, route step id, block id and block version. The entry SHALL preserve the same timestamp, session, application, role, sanitized URL, label, expected, observed, captures, evidence ids and knowledge-observation rules as a live `stage_step`. An event that cites an unknown evidence id or an evidence path outside the run directory SHALL cause the ingestion to fail. Raw input values SHALL not be written unless a block explicitly captured a value.

#### Scenario: Replay sub-steps are journalled
- **WHEN** a replay flow emits two sub-step events for `fillCustomerAddress`
- **THEN** the journal SHALL gain two entries with consecutive sequence numbers and the flow and block identity

#### Scenario: Invalid event fails ingestion
- **WHEN** a replay event has no label or cites evidence that was not written by that run
- **THEN** the server SHALL refuse the event and the replay SHALL not be reported as successfully journalled

### Requirement: Replay evidence is merged into the workflow manifest
The replay fixture SHALL write evidence files and a manifest fragment into the workflow's run evidence directory. The server SHALL validate the fragment, reject a file outside the directory, reject a duplicate evidence id, apply the same caption and redaction rules as live evidence, and merge the accepted entries into the workflow's evidence manifest. The replay result SHALL reference only evidence ids that exist after the merge. Screenshots and recordings SHALL count against the stage's existing per-workflow limits.

#### Scenario: Evidence merge
- **WHEN** a replay stores a screenshot and a trace
- **THEN** the manifest SHALL contain both entries and the replay result SHALL cite their ids

#### Scenario: Limit refused
- **WHEN** a replay tries to store a screenshot after the workflow has reached `maxScreenshots`
- **THEN** the screenshot SHALL be refused with the existing stage limit and the replay SHALL record the refusal without bypassing the cap

### Requirement: Replay journal entries remain readable with the live timeline
`stage_journal` SHALL return replay entries in the same ordered timeline as live entries, with their flow id, plan revision, `inputsHash`, route step id and block version. The flow page SHALL render replay entries as normal steps with their recording offsets when a recording exists. A replay run that is retried SHALL use a new run id and SHALL not overwrite or renumber entries from the earlier run.

#### Scenario: Mixed timeline
- **WHEN** a workflow has live exploratory entries and a later replay run
- **THEN** `stage_journal` SHALL show both in sequence order and identify which entries came from replay

#### Scenario: Retry does not renumber
- **WHEN** the same flow is replayed twice in one workflow
- **THEN** the second run SHALL append new entries with new sequence numbers and SHALL preserve the first run's entries
