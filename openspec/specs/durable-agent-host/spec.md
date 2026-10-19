# durable-agent-host Specification

## Purpose
TBD - created by archiving change add-pi-durable-runtime. Update Purpose after archive.
## Requirements
### Requirement: Bundled durable agent host mode
The executable SHALL provide an internal `agent host` mode that runs a durable agent harness built on `@earendil-works/pi-durable` without requiring any external agent executable. The host mode SHALL use only public entrypoints of exactly pinned pi packages.

#### Scenario: Host runs from the compiled executable
- **WHEN** the compiled executable is started in agent host mode outside any source checkout with a faux model provider configured for tests
- **THEN** the host SHALL open its storage, accept a run, complete a model turn that calls a coding tool, and report the run as idle

#### Scenario: No external pi needed
- **WHEN** a `pi-durable` run is launched on a machine without a `pi` executable on PATH
- **THEN** the launch SHALL NOT fail for a missing executable

### Requirement: One host and storage per workflow
The engine SHALL run at most one durable host process per workflow, owning one SQLite storage in the workflow's private runtime directory. The host SHALL hold a single-writer lock; a second host start for the same workflow SHALL detect the live owner and exit without opening the storage. Each agent run SHALL map to its own conversation, and a persistent role SHALL reuse the conversation previously created for that role.

#### Scenario: Two runs share one host
- **WHEN** two agent runs of the same workflow route to `pi-durable`
- **THEN** both SHALL run as separate conversations in the same host process and storage

#### Scenario: Concurrent host start
- **WHEN** a host is already running for a workflow and another start is attempted
- **THEN** the second start SHALL exit without writing to the storage and the engine SHALL use the running host

#### Scenario: Persistent role reuses its conversation
- **WHEN** a persistent role receives a new assignment in a later round
- **THEN** the assignment SHALL be submitted to the role's existing conversation

### Requirement: Host outlives drains and the dashboard
The host SHALL run detached from the process that started it, so agent work continues after a bounded `workflow drain` or the dashboard exits. The host SHALL stop when the engine stops the workflow's last run or closes the workflow.

#### Scenario: Drain ends while an agent works
- **WHEN** a bounded drain launches a `pi-durable` run and returns
- **THEN** the run SHALL keep working and a later observation SHALL report its current status

#### Scenario: Workflow closes
- **WHEN** the workflow is closed and its runs are stopped
- **THEN** the host SHALL abort remaining work, close its storage and exit

### Requirement: Private control protocol
The host SHALL expose a Unix socket in a directory accessible only to the owning user (directory `0700`, socket `0600`) carrying versioned, newline-delimited JSON requests for hello, ensure-run, submit, status, configure-run, catalog, compact-run, abort, stop-run, shutdown and watch. The host SHALL reject frames above a fixed byte bound, unknown protocol versions, and unknown run ids with a structured error. Secrets such as the run capability token SHALL NOT be transmitted over the socket. A compact-run request SHALL carry the run id and optional bounded summarizer instructions, and the host SHALL answer with a structured outcome rather than an error for a run whose conversation has nothing to compact or is already compacting.

#### Scenario: Oversized frame
- **WHEN** a client sends a frame larger than the bound
- **THEN** the host SHALL reject it with an error and keep serving other clients

#### Scenario: Version mismatch
- **WHEN** a client's hello names an unsupported protocol version
- **THEN** the host SHALL refuse the session with a version error

#### Scenario: Compaction for an unknown run
- **WHEN** a compact-run request names a run the host does not track
- **THEN** the host SHALL answer with the unknown-run error code

#### Scenario: Structured compaction outcome
- **WHEN** a compact-run request is answered
- **THEN** the response SHALL carry one of `started`, `already-compacting` or `nothing-to-compact`, with the admitted task identity for `started` and the compaction reason for `already-compacting`

### Requirement: Exactly-once submissions
Every engine submission SHALL carry a `requestId` derived from the effect idempotency key. A repeated submission with the same `requestId` SHALL return the original submission and SHALL NOT start a second model turn.

#### Scenario: Prompt effect retried after a lost response
- **WHEN** the engine re-sends an assignment prompt with the same `requestId` after a transport failure
- **THEN** the conversation SHALL contain the assignment once

### Requirement: Crash resume
A host started over existing storage SHALL resume unfinished work: interrupted model requests are re-sent, tool calls marked safe to replay re-run, other interrupted tool calls are reported to the model as interrupted, and queued submissions stay queued.

#### Scenario: Host killed during a tool call
- **WHEN** the host process is killed while a non-replayable tool call runs and a new host is started for the workflow
- **THEN** the run SHALL continue, the model SHALL receive an interrupted result for that call, and the call SHALL NOT be executed again

### Requirement: Per-run execution environment
Tool execution for a run SHALL use the run's working directory and the environment from the run's private `run.env` file, so workflow variables, the run capability, classifier binding and telemetry settings apply to that run only.

#### Scenario: Two runs with different environments
- **WHEN** two runs in one host call `bash` to print `HERDR_RUN_ID`
- **THEN** each SHALL print its own run id

### Requirement: A dead tool surface fails the run fast
The host SHALL count each run's consecutive failed tool calls and its successful calls, and SHALL treat a run whose tool surface never worked as surface-dead: zero successful calls in the run plus either five consecutive failures whose machine-readable kinds mean a broken surface (`host-error`, `denied`, `timeout`, `aborted`, `invalid-args`, `other`) or fifteen turns of failures that are all one tool's. The `not-found` and `no-match` kinds SHALL never count towards the five, because exploring a path or a text that is not there is ordinary work, and a run with at least one successful call SHALL never be surface-dead. The thresholds SHALL be named constants with documented defaults.

On the first detection the host SHALL re-probe the run's tool host once, where such a mechanism exists, and grant the run one more turn; the re-probe SHALL be reported as performed or absent rather than assumed. If a call fails again, the host SHALL abort the run's conversation and record the run's own `blocked` handoff, naming the tool, the failure kind(s), the consecutive-failure count, the turns taken and one bounded, secret-free error line — never payload text — which the engine surfaces as the workflow's developer-visible attention. The host SHALL emit a `run.fail-fast` telemetry envelope for the decision carrying the run id, the role, the tool, the failure kinds, the counts, the turns and whether a re-probe was possible.

A session without a run id (an orchestrator conversation is not an engine run) SHALL NOT be monitored, and a role whose first failing calls are its own expected evidence SHALL be exempt.

#### Scenario: Five broken-surface failures with no success
- **WHEN** a run has made five consecutive failures of a broken-surface kind and no successful call
- **THEN** the host SHALL re-probe the run's tool host once, the run SHALL get one more turn, and a further failing call SHALL abort the conversation and record a `blocked` handoff naming the tool, the kinds and the count

#### Scenario: Exploring a missing path
- **WHEN** a run's calls fail with `not-found` or `no-match`
- **THEN** the host SHALL NOT treat the surface as dead and the run SHALL keep working

#### Scenario: One success disables the rule
- **WHEN** a run has had at least one successful call
- **THEN** no failure count SHALL end the run for a dead tool surface

#### Scenario: Tool-host re-probe
- **WHEN** the dead surface is detected for a run that carries an environment capability
- **THEN** the host SHALL re-run the environment-server discovery probe once before the extra turn, and a run without such a host SHALL report that no re-probe mechanism existed

#### Scenario: Exempt roles and the orchestrator
- **WHEN** the failing run's role is `env-setup` or `debug`, or the session carries no run id
- **THEN** the host SHALL NOT count that session's failures towards a dead-surface stop

### Requirement: A conversation's runtime telemetry identity follows the run it serves

The durable host SHALL resolve a conversation's runtime telemetry identity at
each emission rather than once at attachment, so that a conversation reused by a
later run attributes its events to the run that is active. The host SHALL keep
one binding per conversation — the run most recently bound to it — and SHALL
update that binding during `ensureRun` before the run's first submission. The
observers the host installs on the conversation's event stream that name a run
SHALL resolve the run that produced the observation, not whichever run the binding
names when it is delivered: the measured-context observer that feeds the cost
ceiling SHALL charge the run whose message carried the measurement, and the
finished-tool observer that feeds the dead-surface rule SHALL charge the run that
started the call, ignoring an observation for a run the host no longer tracks. A
dead-surface decision SHALL be acted on with the failing run's own context and
SHALL be refused — recorded as an observation of a rebound owner, with no abort
and no handoff — when a later run now holds the conversation. Rebinding SHALL be
observational: it SHALL NOT change which conversation a run uses, when a run is
created, blocked, completed, expired or resumed, or any durable state. The
session window's own transition (reading the previous binding, draining the
stream, writing the new one) SHALL be serialized per conversation, so two
overlapping rebindings cannot close one run twice or leave the last run open.

#### Scenario: A later round of the same role records its own turns

- **WHEN** a run of a step and role closes and a later run of the same step and
  role is served by the same conversation
- **THEN** every event the conversation publishes while the later run is the
  binding SHALL carry the later run's id in its run identity
- **AND** the earlier run SHALL retain only the events published while it was the
  binding

#### Scenario: The ceiling follows the run that produced the measurement

- **WHEN** a measured context is observed on a conversation whose binding has
  moved to a later run
- **THEN** the cost-ceiling observation SHALL be recorded for the run whose
  message carried the measurement, not for the run that created the conversation
  and not for whichever run is bound when it is delivered

#### Scenario: A late failure of a retired run does not stop the run now bound

- **WHEN** a tool call started by one run finishes after another run has been
  bound to the same conversation
- **THEN** the dead-surface observation SHALL be charged to the run that started
  the call
- **AND** a decision it produces SHALL NOT abort the conversation, hand off or
  otherwise act on the run now bound

#### Scenario: Two rebindings of one conversation do not interleave

- **WHEN** a conversation is rebound twice before the first rebinding has recorded
  its window
- **THEN** each run that was left SHALL be closed exactly once, naming the run
  that followed it, and no run SHALL be left unclosed

#### Scenario: A conversation with no run binding records nothing

- **WHEN** a conversation is ensured with no run identity in its environment, as
  an orchestrator session is
- **THEN** rebinding SHALL record no session-window event

#### Scenario: Rebinding does not change the run lifecycle

- **WHEN** a conversation is rebound to a run
- **THEN** the run's stored status, start, completion and capability hash SHALL be
  the same as they would be without the record
- **AND** a failure to attach or emit the record SHALL NOT fail the run

