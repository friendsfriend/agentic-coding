## ADDED Requirements

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
The host SHALL expose a Unix socket in a directory accessible only to the owning user (directory `0700`, socket `0600`) carrying versioned, newline-delimited JSON requests for hello, ensure-run, submit, status, abort, stop-run, shutdown and watch. The host SHALL reject frames above a fixed byte bound, unknown protocol versions, and unknown run ids with a structured error. Secrets such as the run capability token SHALL NOT be transmitted over the socket.

#### Scenario: Oversized frame
- **WHEN** a client sends a frame larger than the bound
- **THEN** the host SHALL reject it with an error and keep serving other clients

#### Scenario: Version mismatch
- **WHEN** a client's hello names an unsupported protocol version
- **THEN** the host SHALL refuse the session with a version error

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
