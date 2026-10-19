# herdr-agent-telemetry Specification

## Purpose
TBD - created by archiving change ui-improvements-and-telemetry. Update Purpose after archive.
## Requirements
### Requirement: User-message correlated agent traces
The system SHALL create one agent-operation span for each assignment or follow-up message handled by any managed runtime and identify workflow, run, step, role, runtime, profile, and message independently of captured content.

#### Scenario: Managed role handles controller prompt
- **WHEN** adapter sends assignment with valid upstream trace context
- **THEN** agent-operation span SHALL continue upstream trace
- **AND** span SHALL identify workflow/run/step/role/runtime/profile and runtime session when available

#### Scenario: Developer sends direct agent message
- **WHEN** managed runtime handles message without valid one-use upstream trace context
- **THEN** bridge SHALL start independent trace
- **AND** it SHALL NOT attach operation to unrelated workflow command

#### Scenario: Agent receives later message
- **WHEN** same runtime session handles another run message
- **THEN** later message SHALL have distinct message ID and operation span
- **AND** actions from runs SHALL not be attributed to each other

### Requirement: Agent action spans
The system SHALL normalize available model turns, tool executions, provider responses, compaction, and runtime errors under active agent-operation span without requiring every runtime to expose same deep hooks.

#### Scenario: Model turn completes
- **WHEN** Pi, OpenCode, or OpenCode V2 bridge receives model-turn lifecycle
- **THEN** it SHALL emit common event/span schema with runtime identifier
- **AND** include timing, outcome, model and available token/cost metadata

#### Scenario: Tool execution completes
- **WHEN** runtime bridge receives tool completion or block
- **THEN** it SHALL emit normalized child tool span with tool/call identity, duration, and outcome
- **AND** tool span SHALL remain under active agent operation

#### Scenario: Runtime lacks deep hook
- **WHEN** adapter cannot observe model or tool detail
- **THEN** baseline assignment, process, status, and handoff telemetry SHALL remain available
- **AND** system SHALL omit unsupported fields rather than infer them

#### Scenario: Parallel tools finish out of order
- **WHEN** runtime reports sibling tool calls concurrently
- **THEN** each normalized tool span SHALL keep independent span ID and parent
- **AND** hierarchy SHALL not depend on event write order

### Requirement: Workflow trace propagation
The system SHALL propagate W3C trace context across unified workflow commands, outbox effects, agent adapters, runtime bridges, and generic handoff.

#### Scenario: Agent invokes workflow command
- **WHEN** instrumented runtime invokes `agentic-coding workflow handoff`
- **THEN** command span SHALL descend from current agent operation when trace context is available
- **AND** successor assignment SHALL receive one-use child context without trace metadata in model prompt

#### Scenario: Verification dispatches parallel roles
- **WHEN** verification step dispatches selected verifier runs
- **THEN** operation spans SHALL descend from initiating workflow command
- **AND** spans SHALL expose workflow/run/step/role/runtime for filtering

#### Scenario: Verification continues to test or fix
- **WHEN** verifier results start test verification or implementation fix
- **THEN** successor assignment spans SHALL remain connected through engine command/effect trace
- **AND** pass, fail, retry, and attempt-limit outcomes SHALL remain visible

#### Scenario: Prompt context is stale or malformed
- **WHEN** runtime starts message with missing, expired, consumed, or malformed handoff context
- **THEN** bridge SHALL ignore it and start independent trace
- **AND** stale context SHALL not connect unrelated run

### Requirement: Best-effort OTLP export and local history
The system SHALL export ended spans as OTLP/HTTP JSON and SHALL retain normalized workflow-local span history without affecting workflow correctness.

#### Scenario: Collector accepts span
- **WHEN** configured OTLP traces endpoint is reachable
- **THEN** system SHALL send valid OTLP/HTTP JSON resource span envelope
- **AND** endpoint selection SHALL honor standard OpenTelemetry traces and base endpoint environment variables

#### Scenario: Collector is unavailable
- **WHEN** endpoint times out, refuses connection, or rejects payload
- **THEN** agent and workflow action SHALL continue unchanged
- **AND** ended managed-workflow span SHALL remain appended to workflow-local trace JSONL

#### Scenario: Existing dashboard summaries load
- **WHEN** new tracing is enabled
- **THEN** existing workflow `telemetry.jsonl` events needed for summaries SHALL continue to be written
- **AND** tracing SHALL NOT require migration of existing workflow state

### Requirement: Telemetry content minimization
The system SHALL omit prompt text, model text, tool arguments, tool results, and repository content from exported spans by default.

#### Scenario: Default content policy
- **WHEN** telemetry runs without explicit content-capture opt-in
- **THEN** message SHALL be represented by stable identifier, hash, length, and safe operation label
- **AND** tool spans SHALL contain operational metadata only

#### Scenario: Message preview is enabled
- **WHEN** developer explicitly enables message preview capture
- **THEN** system SHALL record only configured bounded preview
- **AND** system SHALL still omit model text, tool arguments, tool results, and repository content

### Requirement: Runtime-neutral baseline telemetry
Every registered agent adapter SHALL emit normalized launch, assignment-delivered, observed-status, stop, error, and handoff events on the adapter telemetry layer even when no runtime plugin bridge is installed, each carrying the workflow, run, step, role, profile, runtime, effect, and runtime session identity when the adapter observes it, together with the outcome and duration of the observed lifecycle step.

#### Scenario: Any adapter launches run
- **WHEN** adapter begins and completes launch attempt
- **THEN** baseline events SHALL identify workflow, run, step, role, profile, runtime, effect, attempt, outcome, and duration
- **AND** the adapter SHALL emit one event for the launch attempt start and one for its outcome rather than a single unlabeled event

#### Scenario: Assignment is delivered to a live runtime
- **WHEN** an adapter delivers an assignment or a reused-prompt continuation to a live run
- **THEN** the adapter SHALL emit an assignment-delivered event carrying the run identity, the attempt, and the delivery duration

#### Scenario: Adapter observes stop or failure
- **WHEN** an adapter stops a run, or a launch, prompt, or stop operation fails
- **THEN** the adapter SHALL emit a stop or error event carrying the outcome, the duration, and a bounded error class
- **AND** no telemetry emission failure SHALL alter the workflow outcome

#### Scenario: Runtime bridge fails
- **WHEN** Pi extension or OpenCode plugin throws, is unavailable, or emits malformed data
- **THEN** workflow and agent SHALL continue unchanged
- **AND** baseline adapter telemetry SHALL remain authoritative only for observation, never lifecycle mutation

### Requirement: Telemetry is observational
Telemetry bridge SHALL NOT read or mutate workflow state, decide completion, retry/nudge agents, switch runtime/model, or trigger workflow transition.

#### Scenario: Runtime settles without handoff
- **WHEN** bridge observes idle or settled event
- **THEN** it SHALL emit observation only
- **AND** state engine SHALL retain active run until valid handoff or timeout policy

### Requirement: Usage telemetry carries efficiency metadata

Runtime usage telemetry SHALL include, alongside existing token and cost metadata, cache read token counts, cache write token counts, message duration, and derived tokens-per-second whenever the runtime exposes them, and SHALL export these fields through the OTel log pipeline unchanged. An explicitly reported zero cache-write count SHALL be preserved; a field that the runtime does not expose SHALL remain omitted.

#### Scenario: Pi runtime reports usage with cache detail

- **WHEN** the pi runtime bridge receives a message-usage lifecycle that includes cache read and cache write tokens and timing
- **THEN** the emitted usage event SHALL contain input tokens, output tokens, cache read tokens, cache write tokens, cost, duration, and tokens/s
- **AND** the same envelope SHALL reach both the local telemetry file and the configured OTLP endpoint

#### Scenario: Pi runtime reports no cache writes

- **WHEN** the pi runtime reports a numeric cache-write count of zero
- **THEN** the emitted usage event SHALL contain `cacheWriteTokens: 0`
- **AND** downstream consumers SHALL be able to distinguish known zero cache writes from unavailable cache-write telemetry

#### Scenario: Runtime lacks cache or timing detail

- **WHEN** a runtime bridge cannot observe cache token counts or message timing
- **THEN** it SHALL omit those fields from the usage event rather than emit zero-valued or inferred values

#### Scenario: Downstream consumers read new fields

- **WHEN** the workflow dash aggregates usage events for per-agent metrics
- **THEN** it SHALL read cache-read and cache-write tokens, duration, and tokens/s fields from the same usage events exported via OTel
- **AND** it SHALL include both cache-read and cache-write tokens in the prompt-token denominator
- **AND** no parallel telemetry channel SHALL be required to populate the Agents panel metrics

### Requirement: Self-describing telemetry events

Every exported telemetry event SHALL identify its layer, runtime when runtime-scoped, workflow, step, and, when the event is attributable to one, its run, role, profile, and effect, so that a single event row can be attributed and joined without reading neighboring rows. An event that cannot resolve an identity field SHALL omit it rather than emit a placeholder.

#### Scenario: Event is exported without bridge participation

- **WHEN** the engine or an adapter exports an event while no runtime bridge is installed
- **THEN** the event SHALL still carry its layer, workflow, and step identity
- **AND** it SHALL carry role, profile, and runtime identity when the event is attributable to a run

#### Scenario: Event identity cannot be resolved

- **WHEN** an event cannot be attributed to a run, effect, or runtime session
- **THEN** the corresponding identity fields SHALL be absent
- **AND** the event SHALL remain exported

#### Scenario: Runtime events are joined to engine events

- **WHEN** a runtime bridge event and an engine event refer to the same run and runtime session
- **THEN** both events SHALL carry the same run id and runtime session id
- **AND** a consumer SHALL be able to join them on those fields alone

### Requirement: The session window is recorded on a conversation's run binding

The runtime telemetry stream SHALL record a conversation's run bindings as
session-window events, distinct from the run window the engine records, so that a
session which continues after a run closed is stated rather than inferred. It
SHALL emit `runtime.session_window.opened` with the identity of the run now bound
to the conversation and a `herdr.session.reason` of `created` (the conversation
was created for this run), `rebound` (an existing conversation whose previous run
is known), `adopted` (an existing conversation whose previous run the host cannot
name, as after a host restart) or `resumed` (the conversation bound to the same
run again, as after an abort); on `rebound` it SHALL carry
`herdr.session.previous_run_id`. When the previous binding names a different run,
it SHALL emit `runtime.session_window.closed` with that run's identity and
`herdr.session.rebound_to` naming the run now bound, before the opened record.
Both events SHALL carry the conversation id as `herdr.session.conversation_id`,
never as the envelope's `sessionId`, which means *run* id for every other
envelope and for the telemetry parser. A `closed` record that could not be
written SHALL be retried into the binding that now holds the conversation, and on
that conversation's later bindings, until it lands, because its absence is what a
reader treats as a defect. The events SHALL be additive and observational: they
SHALL write no workflow state, require no schema, snapshot or migration change,
and SHALL NOT close a run or a session.

#### Scenario: A session continues under a later run

- **WHEN** a conversation bound to one run is reused by a later run of the same
  step and role
- **THEN** the stream SHALL emit `runtime.session_window.closed` for the earlier
  run carrying the later run's id as `herdr.session.rebound_to`, then
  `runtime.session_window.opened` for the later run with reason `rebound` and
  `herdr.session.previous_run_id` naming the earlier run
- **AND** both events SHALL carry the conversation id as
  `herdr.session.conversation_id`, and neither SHALL write a `sessionId`

#### Scenario: A new session names its reason

- **WHEN** a run receives a conversation created for it
- **THEN** the stream SHALL emit `runtime.session_window.opened` with reason
  `created` and no previous run id
- **AND** no `runtime.session_window.closed` SHALL be emitted for the
  conversation

#### Scenario: A resumed run reopens its own window

- **WHEN** an aborted run is resumed on its own conversation
- **THEN** the stream SHALL emit `runtime.session_window.opened` with reason
  `resumed` and the run's own id
- **AND** no `runtime.session_window.closed` SHALL be emitted for that run

#### Scenario: An adopted session states no previous run

- **WHEN** a conversation outlives the host that bound it and is reused by a run
- **THEN** the stream SHALL emit `runtime.session_window.opened` with reason
  `adopted` and no previous run id
- **AND** it SHALL emit no `runtime.session_window.closed`, because the host
  cannot name the run it cannot remember

#### Scenario: A close that could not be written

- **WHEN** a `runtime.session_window.closed` record cannot be appended to the
  leaving run's telemetry path, because that run's workspace is gone
- **THEN** the stream SHALL write the same record into the telemetry path of the
  binding that now holds the conversation, or retry it there on the conversation's
  next binding
- **AND** it SHALL write that record once, such that a reader sees exactly one
  `closed` for the run that was left

#### Scenario: Recording a session window never changes a run

- **WHEN** a session-window event is emitted
- **THEN** the run's own recorded window, status and cost SHALL be unaffected
- **AND** a failed emission SHALL leave the run and the workflow unchanged

