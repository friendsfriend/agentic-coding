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

