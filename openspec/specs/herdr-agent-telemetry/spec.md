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
Every registered agent adapter SHALL emit normalized launch, assignment-delivered, observed-status, stop, error, and handoff events even when no runtime plugin bridge is installed.

#### Scenario: Any adapter launches run
- **WHEN** adapter begins and completes launch attempt
- **THEN** baseline events SHALL identify workflow, run, step, role, profile, runtime, effect, attempt, outcome, and duration

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

