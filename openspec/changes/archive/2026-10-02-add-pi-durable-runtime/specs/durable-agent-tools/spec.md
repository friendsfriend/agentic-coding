## ADDED Requirements

### Requirement: Coding tools and read-only policy
A durable run SHALL offer read, write, edit and bash tools. A run whose profile is read-only or requires the `read-only` capability SHALL NOT be offered write or edit tools; bash SHALL remain available for focused checks and the handoff command.

#### Scenario: Read-only verifier
- **WHEN** a read-only verifier run starts on `pi-durable`
- **THEN** the model's tool list SHALL contain read and bash and SHALL NOT contain write or edit

#### Scenario: Writable worker
- **WHEN** a worker run with write capability starts
- **THEN** the model's tool list SHALL contain read, write, edit and bash

### Requirement: Workflow dialogue tools
Every durable run SHALL offer `developer_question` and `agent_ask` with the same parameters, descriptions and validation as the pi workflow extension, executing the workflow question and ask CLI commands with the run's environment. These tools SHALL NOT be replayed after an interruption.

#### Scenario: Developer question from a durable run
- **WHEN** a durable agent calls `developer_question` with a questions array
- **THEN** the workflow question command SHALL be invoked for that run and the developer's answer SHALL be returned as the tool result

#### Scenario: Interrupted question
- **WHEN** the host dies while `developer_question` waits and the host resumes
- **THEN** the model SHALL receive an interrupted result rather than a second question being raised

### Requirement: In-session judgment tool
Every durable run SHALL offer `ask_jev` with the same contract as the pi judgment extension, using only the classifier binding from the run environment. When no binding is present the tool SHALL answer that in-session judgment is unavailable and do nothing else.

#### Scenario: No classifier binding
- **WHEN** a durable run without `AGENTIC_JEV` calls `ask_jev`
- **THEN** the result SHALL state that in-session judgment is unavailable and no network request SHALL be made

### Requirement: System prompt context
The durable system prompt SHALL include a coding-agent preamble, the offered tools, `AGENTS.md`/`CLAUDE.md` context files found from the run's working directory up to its repository root and in the global pi agent directory, and the working directory.

#### Scenario: Repository AGENTS.md
- **WHEN** a run's working directory is inside a repository with a root `AGENTS.md`
- **THEN** the system prompt sent to the model SHALL contain that file's content

### Requirement: Runtime telemetry envelopes
Durable runs SHALL emit the existing runtime telemetry envelope (schema version 1, layer `runtime`, runtime `pi-durable`, workflow/run/step/role/profile identity) for turn, model response, tool start/end, compaction and settle events to the run's telemetry path and configured OTLP endpoint. Content SHALL be captured only when the run's content-capture opt-in is set, and secrets SHALL be redacted with the same rules as the pi bridge.

#### Scenario: Metadata-only by default
- **WHEN** a durable run completes a tool call without the content-capture opt-in
- **THEN** the emitted envelopes SHALL contain no prompt, model text, tool arguments or tool results

#### Scenario: Secret redaction
- **WHEN** content capture is enabled and a tool result contains a token matching the redaction rules
- **THEN** the envelope SHALL contain `[REDACTED]` in place of the token
