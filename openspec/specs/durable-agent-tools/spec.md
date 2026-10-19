# durable-agent-tools Specification

## Purpose
TBD - created by archiving change add-pi-durable-runtime. Update Purpose after archive.
## Requirements
### Requirement: Coding tools and read-only policy
A durable run SHALL offer read, write, edit, bash and grep tools. A run whose profile is read-only or requires the `read-only` capability SHALL NOT be offered write or edit tools; read, bash, grep and the in-session judgment tool SHALL remain available for focused checks, scoped search, bounded judgments and the handoff command.

#### Scenario: Read-only verifier
- **WHEN** a read-only verifier run starts on `pi-durable`
- **THEN** the model's tool list SHALL contain read, bash, grep and `ask_jev` and SHALL NOT contain write or edit

#### Scenario: Writable worker
- **WHEN** a worker run with write capability starts
- **THEN** the model's tool list SHALL contain read, write, edit, bash and grep and the run SHALL NOT restrict its tools to an explicit subset

### Requirement: Bounded `bash` calls
Every durable run's `bash` tool SHALL run a call under a default wall-clock bound of 120 seconds when the caller passes no `timeout`, SHALL honor a caller's own `timeout` up to a ceiling of 3600 seconds, and SHALL state the default, the ceiling and the override in its description. When the bound fires, the command's process group SHALL be stopped, the result SHALL carry the output collected so far plus a line naming the bound, the elapsed time and how to scope the command instead, and the call SHALL be classified as a `timeout` failure. A call that ran past 60 seconds SHALL report its elapsed time in its result.

#### Scenario: No timeout given
- **WHEN** a durable run calls `bash` with a command and no `timeout`
- **THEN** the call SHALL run under a 120-second bound and a command that exceeds it SHALL be stopped with its children and SHALL return the output collected so far plus a line naming the bound and what to do instead

#### Scenario: Caller's timeout wins
- **WHEN** a run calls `bash` with `timeout: 600`
- **THEN** the call SHALL run under that 600-second bound

#### Scenario: A timeout above the ceiling is capped
- **WHEN** a run calls `bash` with a `timeout` above 3600 seconds
- **THEN** the call SHALL run under a 3600-second bound

#### Scenario: A stopped call is a timeout failure
- **WHEN** a call's bound fires
- **THEN** the recorded failure kind for that call SHALL be `timeout`

### Requirement: Search tool
Every durable run SHALL offer a `grep` tool that searches a regular expression over the run's working directory and returns matching lines with their repository-relative path and line number. The tool SHALL refuse an absolute path or a path that escapes the working directory, SHALL bound the lines it returns, and SHALL answer an absent or failing ripgrep by falling back to the platform grep. It SHALL NOT write.

#### Scenario: Verifier searches the assigned scope
- **WHEN** a run calls `grep` with a pattern and a repository-relative path
- **THEN** the result SHALL list the matching lines as `path:line: text` within the tool's own bound

#### Scenario: Pattern with quoting
- **WHEN** the pattern contains a quote or a space
- **THEN** the pattern SHALL reach the search tool as one argument

#### Scenario: Path outside the repository
- **WHEN** the run names an absolute path or a path containing `..`
- **THEN** the tool SHALL refuse and SHALL run no search

#### Scenario: No ripgrep available
- **WHEN** ripgrep is absent from the run's environment
- **THEN** the search SHALL fall back to the platform grep and still return the matching lines

### Requirement: Workflow dialogue tools
Every durable run SHALL offer `developer_question` and `agent_ask` with the same parameters, descriptions and validation as the pi workflow extension, executing the workflow question and ask CLI commands with the run's environment. Each tool SHALL bound its own wait to the agent grace window, SHALL forward the tool call's abort signal to the spawned CLI process, and SHALL return the resulting record to the model whether it is answered, pending, cancelled, or expired. These tools SHALL NOT be replayed after an interruption.

#### Scenario: Developer question from a durable run
- **WHEN** a durable agent calls `developer_question` with a questions array
- **THEN** the workflow question command SHALL be invoked for that run
- **AND** the developer's answer SHALL be returned as the tool result when it arrives within the agent grace window
- **AND** the pending records SHALL be returned as the tool result otherwise

#### Scenario: Question wait expires with no answer
- **WHEN** the agent grace window elapses with the question still pending
- **THEN** the tool SHALL return the pending record with the question identity and status
- **AND** the tool SHALL NOT expire or cancel the durable question

#### Scenario: Aborted question call kills the spawned CLI
- **WHEN** the tool call is aborted while the spawned CLI process is waiting
- **THEN** the tool SHALL abort the spawn so no question process keeps polling
- **AND** the durable question SHALL remain pending for a later answer

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
Durable runs SHALL emit the existing runtime telemetry envelope (schema version 1, layer `runtime`, runtime `pi-durable`, workflow/run/step/role/profile identity) for turn, model response, tool start/end, compaction, run fail-fast and settle events to the run's telemetry path and configured OTLP endpoint. The compaction envelopes SHALL carry the compaction reason (`manual`, `threshold` or `overflow`), whether a generation is blocked waiting for it, the attempt count, the measured duration, the tokens before and after when they are measurable from the conversation's own generation usage, and the outcome with a bounded, redacted error class when the summarizer failed or the compaction was aborted. The `run.fail-fast` envelope SHALL carry the decision, the tool, the failure kind(s), the consecutive-failure and success counts, the turns taken and whether a tool-host re-probe was possible, and SHALL carry no tool argument, result text or payload. Content SHALL be captured only when the run's content-capture opt-in is set, and secrets SHALL be redacted with the same rules as the pi bridge.

#### Scenario: Metadata-only by default
- **WHEN** a durable run completes a tool call without the content-capture opt-in
- **THEN** the emitted envelopes SHALL contain no prompt, model text, tool arguments or tool results

#### Scenario: Secret redaction
- **WHEN** content capture is enabled and a tool result contains a token matching the redaction rules
- **THEN** the envelope SHALL contain `[REDACTED]` in place of the token

#### Scenario: Compaction completes
- **WHEN** a compaction of the run's conversation completes
- **THEN** the emitted compaction envelope SHALL carry its reason, the blocking flag, the attempt count and the measured duration

#### Scenario: Summarizer fails
- **WHEN** the compaction task fails
- **THEN** the emitted compaction envelope SHALL carry the failed outcome and a bounded error class, without the summary text

#### Scenario: A dead tool surface fails the run
- **WHEN** a run is stopped because its tool surface never worked
- **THEN** the emitted `run.fail-fast` envelope SHALL carry the decision, the tool, the failure kinds, the counts and the turns, and SHALL carry no argument or result text

### Requirement: Tool descriptions state the inspection default and the batching rule

The `read`, `grep` and `bash` tool descriptions SHALL each state that tool's part
in the split the agent works with, and the `codemode` description SHALL state
its own: `read` (with
`offset`/`limit`) and `grep` (with a `path` filter) are the default way to inspect
code, `bash` is for builds, tests and `openspec`, and `codemode` chains a search →
filter → summarise pipeline into one turn. The `read`, `grep` and `bash`
descriptions SHALL repeat the batching rule there — independent calls are emitted
in one message rather than one call per turn — rather than leaving it only in the
protocol document. A description SHALL name a tool only when the run's tool set
contains it: the host SHALL resolve whether the run's global agent settings
register `codemode` and SHALL pass that to the description builders, so a run
without `codemode` is not told about it. Every contract these descriptions
already carry SHALL be preserved: the `bash` bound, its ceiling and the override,
the elapsed-time note; `grep`'s refusal of an absolute or escaping path, its line
bound and its platform-grep fallback; `read`'s off-target refusal.

#### Scenario: The inspection default is stated where the tool is chosen

- **WHEN** a durable run is offered `read`, `grep` and `bash`
- **THEN** each of their descriptions SHALL state that `read` and `grep` are the default way to inspect code and that `bash` is for builds, tests and `openspec`

#### Scenario: The batching rule is repeated in the tool descriptions

- **WHEN** a durable run reads the description of `read`, `grep` or `bash`
- **THEN** it SHALL state that independent calls are emitted in one message rather than one call per turn

#### Scenario: `codemode` is described only where it is registered

- **WHEN** the run's global agent settings register `codemode`
- **THEN** the `read`, `grep` and `bash` descriptions SHALL name it as the tool that chains a search → filter → summarise pipeline into one turn
- **AND** when they do not, those descriptions SHALL NOT mention it

#### Scenario: The existing bounds survive the rewrite

- **WHEN** the `bash` description is rendered
- **THEN** it SHALL still state the 120-second default bound, the 3600-second ceiling and the caller's override
- **AND** the `grep` description SHALL still state its line bound and its platform-grep fallback

