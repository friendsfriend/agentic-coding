# durable-failure-recovery Specification

## Purpose
TBD - created by archiving change durable-failure-recovery. Update Purpose after archive.
## Requirements
### Requirement: Structured runtime failure diagnostics
The durable host SHALL register the pinned Harness structured report callback and record bounded diagnostics and runtime events for reported failures. The projection SHALL distinguish `task_faulted`, `task_parked` with upstream reason `restart_limit`, and host, session, or extension failures. It SHALL NOT conflate these runtime reports with developer questions, workflow gates, or workflow completion. Diagnostics SHALL omit raw prompts, tool arguments, and tool results, redact secrets, bound error text, and isolate callback failures so reporting cannot stop the host or recursively report its own failure.

#### Scenario: Harness reports a parked task
- **WHEN** pi-durable reports a task parked because it reached `restart_limit`
- **THEN** the host SHALL emit a bounded runtime diagnostic preserving the parked task identity and reason, classify it as a runtime task event, and leave workflow lifecycle state unchanged

#### Scenario: Harness reports a task fault or host failure
- **WHEN** the Harness reports a faulted task or a host, session, or extension failure
- **THEN** the resulting event SHALL preserve the corresponding failure class/domain without representing it as a developer question, review gate, or successful workflow completion

#### Scenario: Report contains sensitive or oversized error detail
- **WHEN** a structured report contains an error string with secrets or excessive length, or includes prompt/tool payload fields
- **THEN** diagnostics and runtime events SHALL contain only a redacted, bounded error summary and allow-listed metadata, never the raw prompt, arguments, or results

#### Scenario: Diagnostic callback fails
- **WHEN** logging or runtime-event delivery throws while processing a Harness report
- **THEN** the host SHALL continue serving requests and SHALL NOT re-enter the same report path to report the diagnostic failure

### Requirement: Parked task status is visible and actionable
The agent host and agent views SHALL expose a currently parked task as a distinct runtime state, including its actionable task identity and upstream `restart_limit` reason. Runtime state SHALL remain separate from workflow run state: a parked task SHALL NOT imply that the workflow completed, reached a review gate, or was blocked by a developer question. Ordinary queued, working, question-blocked, and terminal status meanings SHALL remain unchanged.

#### Scenario: Late-joining agent view shows a parked task
- **WHEN** an agent session or Agents panel is opened after a durable task has been parked
- **THEN** it SHALL show the parked state, the task identity, and `restart_limit` as the reason without requiring a transient event to still be on screen

#### Scenario: Normal question and queue status are unchanged
- **WHEN** a run is queued, working, waiting on a developer question, or terminal without a parked task
- **THEN** the runtime view SHALL preserve its existing status interpretation and SHALL NOT label the ordinary state as a parked task

#### Scenario: Parked runtime task is not workflow completion
- **WHEN** the host reports a parked runtime task for a workflow run
- **THEN** the workflow SHALL retain the engine's authoritative status and SHALL NOT be marked complete solely because the runtime task stopped

### Requirement: Explicit retry of an eligible parked task
A developer SHALL be able to explicitly request retry of one named durable task through the host's native `Harness.retryTask(id)` capability. The host SHALL validate live host/run/conversation ownership, current task identity and parked state, `restart_limit` eligibility, and nonterminal workflow state that is not awaiting a developer review or gate before retrying. It SHALL revalidate inside a serialized operation, handle duplicate/stale/cross-run requests safely, and SHALL NOT automatically retry tasks or revive closed/terminal workflows.

#### Scenario: Explicit retry continues an eligible parked task
- **WHEN** the developer explicitly retries the displayed task id while its owning run and workflow remain active and that task is still parked for `restart_limit`
- **THEN** the host SHALL call native `Harness.retryTask(id)` for that task only, report a structured retry outcome, and the agent SHALL be able to continue when the task succeeds

#### Scenario: Retry request is stale, duplicate, or cross-run
- **WHEN** a retry names a task that is no longer parked, is already being retried, belongs to another run/conversation, or is not known to the host
- **THEN** the host SHALL return a bounded structured stale/already-in-progress/refused outcome and SHALL NOT retry another task or mutate the wrong conversation

#### Scenario: Workflow is terminal, closed, or at a review/gate
- **WHEN** an otherwise parked task is requested after its workflow became terminal/closed or while a developer review/gate is pending
- **THEN** the host SHALL refuse the retry and SHALL NOT revive the workflow or bypass the pending developer decision

#### Scenario: Retry does not claim exactly-once external effects
- **WHEN** the developer confirms retry for a parked task whose prior attempt may have had external effects
- **THEN** the UI and result SHALL identify the retried task and explain that native retry behavior does not guarantee exactly-once side effects

### Requirement: Retained compaction failure lifecycle is visible
Agent views SHALL surface the retained `pi.live.compactionFailure` as a bounded failure indication and SHALL keep it visible to a late-joining view until the upstream live value clears it. A subsequent successful compaction that clears the upstream failure SHALL clear the displayed indication. Failed compaction SHALL not be displayed as a successfully placed summary.

#### Scenario: Compaction failure remains visible after it settles
- **WHEN** a summarization attempt fails and pi-durable retains `pi.live.compactionFailure`
- **THEN** the agent session and Agents view SHALL show a bounded failure indication after the in-flight activity ends and after a late join

#### Scenario: Successful compaction clears retained failure
- **WHEN** a later compaction succeeds and pi-durable clears `pi.live.compactionFailure`
- **THEN** the agent views SHALL remove the old failure indication and show the successful compaction outcome only

### Requirement: Failure recovery preserves durable replay and crash-loop protections
Failure visibility and user-initiated recovery SHALL preserve pi-durable's finite native crash-loop protection and use its public task semantics. A retry SHALL apply only to the explicitly selected eligible parked task. The system SHALL document that replay may repeat external effects from an uncertain prior attempt and SHALL NOT promise exactly-once execution.

#### Scenario: Repeated crash and host reopen retains native parking
- **WHEN** a task repeatedly crashes across host reopen without a new durable checkpoint until pi-durable reaches its configured restart limit
- **THEN** the task SHALL remain parked with `restart_limit`, the host SHALL display that state, and no code path SHALL disable the limit or retry automatically

