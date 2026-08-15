## MODIFIED Requirements

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

## ADDED Requirements

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
