# stage-flow-journal Specification

## Purpose
TBD - created by archiving change add-stage-flow-evidence. Update Purpose after archive.
## Requirements
### Requirement: Step journal
The system SHALL offer `stage_step` to an agent with a stage-bound session. Each call SHALL append one entry to the workflow's `stage-journal.jsonl` beside its evidence manifest with a sequence number, the server time, the session, the session's stage application and role, the session's current URL (sanitized), the agent's label, expected and observed text, captured values, referenced evidence ids and an optional knowledge observation (`concept`, `section`, `kind` of `confirmed`, `contradicted`, `missing` or `new`, and for `contradicted` a `suspectedCause` of `product-change`, `regression` or `unknown`). Every entry SHALL pass through the shared redactor before it is written. A referenced evidence id that does not exist in the manifest SHALL be refused. `stage_journal` SHALL return the latest entries, bounded, optionally filtered by session or application.

#### Scenario: Recording a step
- **WHEN** an agent calls `stage_step({ session: "customer", label: "Submit request", expected: "Confirmation page", observed: "Confirmation GA-2025-0042", captures: { requestId: "GA-2025-0042" } })`
- **THEN** the journal SHALL gain an entry with the next sequence number, the server time, application `customer` and the captured request id

#### Scenario: Unknown evidence id
- **WHEN** a `stage_step` call references an evidence id that is not in the manifest
- **THEN** the call SHALL be refused and the journal SHALL be unchanged

#### Scenario: Reading back after compaction
- **WHEN** an agent calls `stage_journal({ app: "customer" })`
- **THEN** the result SHALL list the customer application's entries with their captured values

### Requirement: Flow segments carry offsets
While a stage-bound session records, every journal entry for that session SHALL carry the segment number and the offset in milliseconds since the recording started. When the recording is stopped with `keep: true`, the server SHALL record the kept video's evidence id on those entries; when it is discarded, the entries SHALL keep no segment reference. The total kept recording time per workflow and stage SHALL be bounded by the stage's `limits.maxRecordingMinutes`, refusing a further `browser_record_start` with `stage-recording-limit`.

#### Scenario: Step during a recording
- **WHEN** a session started recording at 10:00:00 and the agent records a step at 10:01:42
- **THEN** the entry SHALL carry offset 102000 ms and, once the segment is kept, the video's evidence id

#### Scenario: Recording budget exhausted
- **WHEN** the kept recordings of a workflow on a stage already total `maxRecordingMinutes`
- **THEN** `browser_record_start` on that stage SHALL be refused with `stage-recording-limit`

### Requirement: Server-side bounded waits
The system SHALL offer `stage_wait({ session, until, reload?, intervalSeconds?, timeoutSeconds })` where `until` is exactly one of `text`, `selector`, `url` or `mail` (`{ to?, subject? }`). The server SHALL check the condition every `intervalSeconds` (minimum 5), reloading the page first when `reload` is true, until the condition holds or `timeoutSeconds` elapses, and SHALL answer once with `met` and the elapsed time or `timeout`. `timeoutSeconds` above the stage's `maxWaitSeconds` SHALL be capped to it. A `mail` condition SHALL be valid only on a session of a `mail-catcher` application declaring `api: "mailpit"` and SHALL be checked through the Mailpit search API on that application's origin.

#### Scenario: Waiting for a mail
- **WHEN** an agent waits for a mail to `applicant@example.test` with subject containing `GA-2025-0042` and it arrives after 40 seconds
- **THEN** the call SHALL answer `met` after about 40 seconds as one tool result

#### Scenario: Timeout capped
- **WHEN** an agent asks for `timeoutSeconds: 3600` on a stage whose `maxWaitSeconds` is 600
- **THEN** the call SHALL give up after at most 600 seconds with `timeout`

### Requirement: Flow page
For a workflow with a journal, the system SHALL render `stage-flow.html` beside the evidence from the journal and the manifest: segments in journal order, each with its video referenced by relative path, and each step as a link to its segment at its offset using a `#t=` media fragment, together with its label, application, role and evidence captions. The page SHALL be regenerated whenever the journal or the manifest changes and SHALL pass through the shared redactor.

#### Scenario: Step link seeks
- **WHEN** step 7 was recorded at offset 102000 ms of the segment kept as `01J…webm`
- **THEN** the flow page SHALL link step 7 to `01J…webm#t=102`

### Requirement: Plan runner writes journal entries without a model call
`stage_run` SHALL append one `stage-journal.jsonl` entry for each `ctx.step` event emitted by an executing block, in event order, without requiring the agent to call `stage_step` for that event. Each entry SHALL use the same sequence, server time, session, application, role, sanitized URL, label, expected, observed, captures, evidence ids and knowledge-observation rules as `stage_step`, and SHALL additionally name the plan id, route step id when present, block id, block version and sub-step label. Every entry SHALL pass through the shared redactor before it is written. A referenced evidence id that does not exist SHALL be refused. A block that completes without emitting at least one sub-step SHALL be recorded as a block contract violation.

#### Scenario: Block sub-steps are recorded
- **WHEN** `fillCustomerAddress` emits `ctx.step("fill street")` and `ctx.step("save address")`
- **THEN** the journal SHALL gain two entries in that order with the block id and version and no separate `stage_step` call

#### Scenario: Block emits no sub-step
- **WHEN** a block returns successfully without calling `ctx.step`
- **THEN** the runner SHALL record a contract violation for that block and SHALL NOT silently accept the step as journalled

### Requirement: Block sub-steps retain plan order and identity
A runner-written journal entry SHALL carry the plan's step index, the route step id when the plan came from a stage plan, the block id and version, and the sub-step label. Entries from one block SHALL appear consecutively and in the order the block emitted them. `stage_journal` SHALL return these fields beside the existing entry fields so the report can reconstruct the block-backed timeline and attribute a failure to one sub-step.

#### Scenario: Timeline reconstruction
- **WHEN** an agent reads back the journal for a plan with three blocks
- **THEN** the entries SHALL show the three plan steps in order and each block's sub-steps consecutively beneath it

#### Scenario: Failure attribution
- **WHEN** the second sub-step of the second block fails
- **THEN** the journal entry SHALL identify plan step 2, the block id and version, and the second sub-step

### Requirement: Block failure evidence is scoped and bounded
On a block failure, the runner SHALL store a screenshot and a scoped snapshot of the failing region as evidence, together with a bounded console tail and a bounded network tail. It SHALL NOT store a full-page DOM snapshot on failure. The screenshot SHALL count against the stage's per-workflow `limits.maxScreenshots`; a failure beyond that limit SHALL be recorded with the available evidence and the refusal reason rather than bypassing the limit. The failure result and journal entry SHALL name the evidence ids and captions.

#### Scenario: Failure captures the failing region
- **WHEN** a block fails on a validation message inside a form
- **THEN** the journal entry SHALL reference a screenshot and a scoped snapshot containing the form region, plus the console and network tails

#### Scenario: Screenshot limit
- **WHEN** a workflow has already stored `maxScreenshots` screenshots and a block fails
- **THEN** the runner SHALL record the failure with the remaining evidence types and SHALL note that the screenshot was refused by the stage limit

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

