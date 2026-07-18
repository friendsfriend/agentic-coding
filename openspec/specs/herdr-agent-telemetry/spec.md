# herdr-agent-telemetry Specification

## Purpose
TBD - created by archiving change ui-improvements-and-telemetry. Update Purpose after archive.
## Requirements
### Requirement: User-message correlated agent traces
The system SHALL create one agent-operation span for each Pi user message handled by a managed role and SHALL identify that message independently of captured message content.

#### Scenario: Managed role handles controller prompt
- **WHEN** workflow controller prompts a managed role with valid upstream trace context
- **THEN** role's agent-operation span SHALL continue upstream trace
- **AND** span SHALL identify workflow change, role, phase, verification round when present, Pi session, and user-message entry

#### Scenario: Developer sends direct agent message
- **WHEN** managed agent receives user message without valid upstream trace context
- **THEN** system SHALL start new trace for that message
- **AND** all instrumented actions caused by message SHALL descend from its agent-operation span

#### Scenario: Agent receives later message
- **WHEN** same agent session handles another user message
- **THEN** later message SHALL have distinct message identifier and agent-operation span
- **AND** actions from two messages SHALL NOT be attributed to each other

### Requirement: Agent action spans
The system SHALL trace model turns and tool executions performed for active user message with timing, outcome, and non-content operational attributes.

#### Scenario: Model turn completes
- **WHEN** agent completes model turn
- **THEN** system SHALL end child model span under active agent-operation span
- **AND** span SHALL include provider/model, stop or error outcome, and available input/output/cache token usage and cost

#### Scenario: Tool execution completes
- **WHEN** agent tool execution succeeds, fails, or is blocked
- **THEN** system SHALL end child tool span under active agent-operation span
- **AND** span SHALL include tool name, tool-call identifier, duration, and error status

#### Scenario: Parallel tools finish out of order
- **WHEN** agent runs sibling tool calls concurrently
- **THEN** each tool SHALL retain independent span identifier and correct parent
- **AND** trace hierarchy SHALL NOT depend on completion or file-write order

### Requirement: Workflow trace propagation
The system SHALL propagate W3C trace context across instrumented Bash, `herdr-workflow`, and managed role prompt boundaries.

#### Scenario: Agent invokes workflow command
- **WHEN** instrumented Bash tool invokes `herdr-workflow`
- **THEN** command action span SHALL descend from Bash tool span
- **AND** downstream roles prompted by command SHALL receive one-use child trace context without adding trace metadata to model prompt text

#### Scenario: Verification dispatches parallel roles
- **WHEN** triage dispatches selected verifiers for verification round
- **THEN** verifier agent-operation spans SHALL remain descendants of initiating verification trace
- **AND** spans SHALL expose change ID, round, tier, and verifier role for filtering

#### Scenario: Verification continues to test or fix
- **WHEN** selected verifier results cause test verification or worker fix
- **THEN** next role prompt and its actions SHALL remain connected through inherited trace context
- **AND** pass, fail, retry, and timeout workflow actions SHALL be visible as spans

#### Scenario: Prompt context is stale or malformed
- **WHEN** managed role starts message with missing, expired, consumed, or malformed handoff context
- **THEN** extension SHALL ignore context and start independent trace
- **AND** stale context SHALL NOT attach message to unrelated workflow action

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

