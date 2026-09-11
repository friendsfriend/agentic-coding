# agent-session-payloads Specification

## Purpose
TBD - created by archiving change enrich-workflow-telemetry-payloads. Update Purpose after archive.
## Requirements
### Requirement: Runtime session identity on every event

Every pi and opencode bridge event SHALL carry the runtime session id, the runtime id, the model id and provider id when the runtime exposes them, and the workflow, run, step, role, and profile identity supplied by the engine environment. Turn-scoped events SHALL additionally carry a monotonically increasing turn index for the session.

#### Scenario: Pi bridge emits a lifecycle event

- **WHEN** the pi bridge emits a start, settle, or tool event
- **THEN** the event SHALL contain the session id, the runtime id, the model id, the provider id, the thinking level, and the turn index
- **AND** the event SHALL contain the workflow, run, step, role, and profile identity

#### Scenario: Opencode bridge emits an event

- **WHEN** the opencode plugin emits an event for a session
- **THEN** the event SHALL contain the session id and the model id and provider id of the message that caused it, when one is available

### Requirement: Pi tool execution payload

The pi bridge SHALL report tool identity, tool call identity, exact tool duration, argument and result sizes, and a bounded failure classification for every completed tool execution, and SHALL correlate the completion with its start even when several tool calls run concurrently.

#### Scenario: Tool execution completes

- **WHEN** the pi runtime reports a completed tool execution
- **THEN** the emitted event SHALL contain the tool name, the tool call id, the outcome, the duration in milliseconds, and the argument and result byte sizes
- **AND** a failed execution SHALL report a bounded error class instead of the raw tool result

#### Scenario: Parallel tools finish out of order

- **WHEN** two tool executions start before either finishes
- **THEN** each completion SHALL report the duration of its own call
- **AND** durations SHALL NOT be assigned by completion order

### Requirement: Pi provider response and retry telemetry

The pi bridge SHALL emit a provider-response event for every provider response it observes, reporting the HTTP status, the request latency, and the retry or error classification when the runtime classifies one, and SHALL emit a turn event at each turn boundary.

#### Scenario: Provider response is received

- **WHEN** the pi runtime reports a provider response
- **THEN** the bridge SHALL emit a provider-response event containing the status code and the request latency in milliseconds

#### Scenario: Provider response reports failure status

- **WHEN** a provider response carries a non-success status
- **THEN** the event outcome SHALL be `error`
- **AND** the event SHALL report a bounded error class rather than response body text

#### Scenario: Model turn completes

- **WHEN** a turn ends
- **THEN** the bridge SHALL emit a turn event containing the turn index, the turn duration, the tool call count, and the tool error count for that turn

### Requirement: Pi model selection and context telemetry

The pi bridge SHALL emit a model-selection event when the session model changes and SHALL report context usage on session settle and a compaction event whenever compaction runs, so context pressure and compaction cost are measurable per run.

#### Scenario: Session model changes

- **WHEN** the pi runtime selects a different model for the session
- **THEN** the bridge SHALL emit a model-selection event containing the new model id, the previous model id, and the selection source

#### Scenario: Context is compacted

- **WHEN** the pi runtime compacts the session
- **THEN** the bridge SHALL emit a compaction event containing the token usage before and after the compaction, the compaction duration, and whether the compaction was automatic

#### Scenario: Agent run settles

- **WHEN** an agent run settles
- **THEN** the settle event SHALL contain the context usage percentage and token count at settle time
- **AND** the settle event SHALL contain cumulative session input, output, cache-read, and cache-write tokens, cumulative cost, turn count, tool call count, and tool error count

### Requirement: Opencode part payload

The opencode plugin SHALL discriminate message-part updates by part type and report the payload of the parts that describe work and usage, instead of forwarding only the session id.

#### Scenario: Step finishes in opencode

- **WHEN** the opencode plugin observes a message part of type `step-finish`
- **THEN** the emitted event SHALL contain the step cost, input, output, reasoning, cache-read, and cache-write token counts, and the finish reason
- **AND** the event SHALL contain a duration for the step

#### Scenario: Tool part changes state

- **WHEN** the opencode plugin observes a message part of type `tool`
- **THEN** the emitted event SHALL contain the tool name, the call id, the tool state, and, when the state reports both start and end times, the tool duration
- **AND** a tool in the error state SHALL report a bounded error class

#### Scenario: Part carries generated text

- **WHEN** the opencode plugin observes a text or reasoning part
- **THEN** the emitted event SHALL contain only the part's character length
- **AND** the event SHALL NOT contain the generated text

#### Scenario: Retry or compaction part is observed

- **WHEN** the opencode plugin observes a retry or compaction part
- **THEN** the emitted event SHALL contain the retry attempt count or the compaction flag respectively

### Requirement: Opencode session payload

The opencode plugin SHALL report session status, session errors, permission round-trips, todo state, and produced diffs with their measurable fields.

#### Scenario: Session status changes

- **WHEN** the opencode plugin observes a session status change
- **THEN** the emitted event SHALL contain the status, and, for a retry status, the attempt number, the retry delay, and a bounded retry reason

#### Scenario: Permission is requested and answered

- **WHEN** the opencode plugin observes a permission request and its reply
- **THEN** the emitted events SHALL contain the permission type, the pattern count, the reply outcome, and the elapsed time between request and reply

#### Scenario: Todos or diff are reported

- **WHEN** the opencode plugin observes a todo update or a session diff
- **THEN** the todo event SHALL contain the total todo count and the count per status
- **AND** the diff event SHALL contain the changed file count, additions, and deletions

#### Scenario: Session error is reported

- **WHEN** the opencode plugin observes a session error
- **THEN** the emitted event SHALL report a bounded error class and whether the error is retryable
- **AND** it SHALL NOT export raw provider or stack text

### Requirement: Runtime event noise is not exported

Runtime bridges SHALL NOT export event families that carry no analysis value: opencode pty, tui, server, installation, lsp-updated, and file-watcher events SHALL be dropped at the bridge, and pi tool-update and message-update streaming events SHALL NOT be exported.

#### Scenario: Noise-only event arrives

- **WHEN** the opencode plugin receives a pty, tui, server, installation, lsp-updated, or file-watcher event
- **THEN** the plugin SHALL emit nothing for that event

#### Scenario: Streaming update arrives

- **WHEN** the pi runtime reports a tool execution update or a message update
- **THEN** the bridge SHALL NOT export a telemetry event for that update
- **AND** the completion event for that tool call or message SHALL remain exported

