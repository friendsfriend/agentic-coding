# agent-environment-tools Specification

## Purpose
Durable agents build, start, inspect and stop their workflow's apps through
owner-scoped tools that wait for busy apps without model turns, with bounded
and redacted output.
## Requirements
### Requirement: Owner-scoped environment capability

Every durable workflow run SHALL receive an environment capability bound to its workflow owner; the server SHALL derive the owner from the capability and SHALL reject any attempt to stop or start on behalf of another owner.

#### Scenario: Stop of another workflow's app

- **WHEN** a run of `workflow:a` calls `env_stop` for an app held by `workflow:b`
- **THEN** the server SHALL refuse and `workflow:b`'s run SHALL keep running

### Requirement: Environment tools for every durable run

Every durable run, including read-only runs, SHALL be offered `env_list`, `env_start`, `env_status`, `env_stop`, `env_build`, `env_test` and `env_logs`, and these tools SHALL NOT be replayed after an interruption. A run launched outside the server process — by the CLI or by the TUI — SHALL receive the same capability through the server's discovery record as a run the server launched itself.

#### Scenario: Read-only verifier starts the app

- **WHEN** a read-only verifier run starts
- **THEN** its tool list SHALL contain the environment tools and SHALL NOT contain write or edit

#### Scenario: Run started by the CLI

- **WHEN** an `env-setup` workflow is started by the CLI against a running server
- **THEN** its author run SHALL have the environment tools registered and a call to `env_list` SHALL answer with that workflow's apps instead of "no agent environment capability"

### Requirement: env_start waits for held apps

`env_start` SHALL block while any requested app is held by another owner, report progress with queue position and holder, return `still-waiting` with the position when its timeout elapses, keep the position on a repeated call, and return `deadlock` immediately when the server detects a cycle.

#### Scenario: App held by another workflow

- **WHEN** an agent calls `env_start` for `customer-mw` held by another workflow, and that workflow stops it ten minutes later
- **THEN** the tool call SHALL return `started` with the endpoints after the stop, without the model taking a turn in between

#### Scenario: Timeout

- **WHEN** the requested app stays held beyond `timeoutSec`
- **THEN** the tool SHALL return `still-waiting` with the current queue position

### Requirement: Bounded and redacted output

Environment tool results SHALL be bounded in size and SHALL replace values from the configuration `.env` and secret action values with a redaction marker.

#### Scenario: Secret in logs

- **WHEN** an app logs the value of `ICON_APPLICATION_MASTERPASSWORD` and the agent calls `env_logs`
- **THEN** the result SHALL contain `«redacted:ICON_APPLICATION_MASTERPASSWORD»` instead of the value

### Requirement: Every environment tool resolves the owner's configuration view

`env_list`, `env_start`, `env_build`, `env_test` and `env_logs` SHALL resolve the definitions of the requesting owner's configuration view — a setup workflow's staged root when it has one, the live configuration otherwise — so a tool never acts on a different layout than the owner's other tools.

#### Scenario: env_build uses the staged build definition

- **WHEN** an `env-setup` run calls `env_build` for an app whose build definition it staged
- **THEN** the run SHALL execute the staged definition, not the live one

#### Scenario: Another owner is unaffected

- **WHEN** a run of a workflow with no staged root calls `env_build`
- **THEN** the live configuration SHALL be used exactly as before

### Requirement: env_list reports staged and default targets

`env_list` SHALL report the targets of the owner's configuration view, SHALL mark each target that resolved from a staged root, and SHALL mark the default target per app and action — or mark the action as having an ambiguous default instead of silently choosing one.

#### Scenario: Staged target is marked

- **WHEN** an `env-setup` run lists an app whose run and build targets were staged
- **THEN** those targets SHALL be marked as staged, and the target the tools would run by default SHALL be marked as the default

#### Scenario: A staged definition is a symlink

- **WHEN** the owner's staged root holds a definition file that is a symlink to a file outside it
- **THEN** `env_list` SHALL report that staged path and the target it points at, so the author deletes the link and writes a regular file instead of writing through it
- **AND** an owner without a staged configuration view SHALL report no such entry

#### Scenario: Ambiguous default is reported

- **WHEN** an app declares two build targets for the same default profile
- **THEN** the listing SHALL mark the build action's default as ambiguous and SHALL name both targets

### Requirement: A start reports running only when the declared readiness passed

`env_start` SHALL report an app's run as `running` only after the readiness the app's own definition declares has passed. It SHALL wait, bounded by the configured readiness timeout (`environment.instances.readiness_timeout_seconds`, default 120 s), for that readiness:

- a docker/compose target: every container of the app's compose project running, a container that declares a healthcheck `healthy`, and otherwise the published ports accepting connections on `127.0.0.1`;
- a script target: an endpoint its own header declares (`# devenv:ready=<http(s) url | host:port>`) answering (status under 400 for a URL, a TCP connection for `host:port`);
- a target that declares no readiness at all: the settle window (`environment.instances.run_settle_seconds`, default 2 s), which SHALL be the only claim made about it.

When the bound expires the call SHALL answer `starting`, naming what it is waiting for and the last probe's own result, and the run SHALL keep the slot. A run that dies while the start waits SHALL fail the call: kind `run-exited` for a script, with its exit status and a bounded tail of its captured output; the container's own last output lines for a docker run. A failed start SHALL release the slot.

#### Scenario: The run target dies at once

- **WHEN** an agent calls `env_start` for a shell run target whose script exits 1 because `node_modules` is missing
- **THEN** the call SHALL fail with `run-exited`, the exit status and the run's last output lines, and the app SHALL NOT be held

#### Scenario: A declared readiness that has not passed

- **WHEN** an agent calls `env_start` for a shell run target whose `devenv:ready=` endpoint does not answer yet
- **THEN** the call SHALL answer `starting` with what it is waiting for and the last probe result, and `env_start` SHALL NOT answer `started`

#### Scenario: A container is up but the application is not serving

- **WHEN** an agent calls `env_start` for a compose app whose container is running while its declared healthcheck is still `starting` or its published port refuses connections
- **THEN** the call SHALL keep waiting within the bound and SHALL answer `starting` with the last probe result when the bound expires, rather than `started`

#### Scenario: The run dies while the start waits

- **WHEN** a declared readiness never passes and the run's process or container exits first
- **THEN** the start SHALL fail with the run's exit status and its last output lines, and the app SHALL NOT stay held

### Requirement: env_status agrees with observation in every phase

`env_status` SHALL report an app's run from what can be observed: `starting` while the start is in flight, `running` once it holds the slot and its process or container is there, the run's state with its exit code and a bounded tail of its output once it ended, and `stopped` after a stop. It SHALL report the readiness the definition declares (`ready`, `waitingFor`, `lastProbe`) so a run that is up but not serving is never called ready. A persisted `running` row whose run this server process cannot observe (a process that is gone, a row a previous process left behind) SHALL NOT be reported as `running`; the slot SHALL keep holding the app until a stop or a developer release clears it.

#### Scenario: Dead process, stale row

- **WHEN** a row reads `running` but its process is gone
- **THEN** `env_status` SHALL report the run as ended (with its exit code and last output lines when the run recorded them) or as unknown, never as running

#### Scenario: Up but not serving

- **WHEN** an app's container is running while its declared readiness has not passed
- **THEN** `env_status` SHALL report `readiness.ready` as false with what it is waiting for, and SHALL report it ready once the probe passes

### Requirement: One run record answers every status signal

`env_status`, `env_logs`, the app status API and the run's own captured log SHALL derive from the single environment instance record for that app: the holder, the run's runtime, its state and, for a run that ended, its exit code. A run that ended SHALL be reported as such even when the slot row still reads `running`.

#### Scenario: A dead run

- **WHEN** an agent calls `env_status` for an app whose run just failed with exit code 1
- **THEN** the answer SHALL carry the run's runtime, state, exit code and the last lines of its captured output

#### Scenario: A live run

- **WHEN** a workflow holds an app whose script run is still alive
- **THEN** `env_status` and the app status API SHALL both report it as running

### Requirement: env_logs reads the source that belongs to the runtime

`env_logs` SHALL read a container app's output from its compose project's containers, a shell (script) run's output from the file that run's own stdout and stderr were captured to, and an infrastructure service's output from its declared log file or Kubernetes release. A missing container runtime SHALL be reported with what was probed (the runtime command, the endpoints tried and that no daemon answered) rather than as a bare unavailability.

#### Scenario: A shell app

- **WHEN** an agent calls `env_logs` for an app running a script run target
- **THEN** the answer SHALL be the lines that run wrote, and SHALL NOT depend on a container runtime

#### Scenario: No daemon answers

- **WHEN** the configured runtime's candidates do not answer
- **THEN** the refusal SHALL name the command, every endpoint probed and the fact that none answered

### Requirement: an infrastructure service's state is a probe

`env_list` and `env_status` SHALL report an infrastructure service's state from the container runtime the composition attached: `running`/`starting`/`stopped`/`failed` from the container's own status, `not-created` when the runtime is attached and no container of the service exists, and `unknown` only when no runtime could be asked (none was selected, or the daemon could not be read).

#### Scenario: A service that was never created

- **WHEN** an agent calls `env_status` for a configured infrastructure service that has no container
- **THEN** the answer SHALL report `not-created`, not `unknown`

#### Scenario: No container runtime

- **WHEN** the server selected no container runtime at all
- **THEN** the answer SHALL report `unknown` and the refusals that need a runtime SHALL name what was probed

### Requirement: every server root attaches the one environment composition

Both composition roots — the headless server and the TUI's own listener — SHALL build the environment stack through the one composition (`createEnvironmentStack`), so every capability the agent environment routes read (the container runtime behind `env_logs`, an infrastructure state probe, `env_build`/`env_test`, the slot controller's runtimes) is attached in both. A route that needs a capability SHALL answer with what is missing instead of claiming a result.

#### Scenario: env_logs for a docker app on the TUI's listener

- **WHEN** the TUI owns the server and an agent calls `env_logs` for a docker compose app or an infrastructure service
- **THEN** the answer SHALL be that app's or service's container output, not "the server attached no container-runtime capability at all"

#### Scenario: An infrastructure state read on the TUI's listener

- **WHEN** the TUI owns the server and an agent calls `env_status` for an infrastructure service
- **THEN** the state SHALL come from the container runtime, as it does on the headless server

### Requirement: env_list is compact and reports the infrastructure

`env_list` SHALL answer a compact listing by default — per app the holder, status and one row per target naming what the tools accept — with `detail: "full"` or an `app` filter returning the ids and the reason each default was chosen, so the answer fits inside the tool's own output bound. It SHALL report the configured infrastructure services with their ident, kind, observed state, ports when known, and the declared `db_query` connection. `env_status` SHALL accept an infrastructure ident, and `env_start`/`env_stop` SHALL refuse one with what starts it, naming the requiring app when a live dependency lease names it.

#### Scenario: Default listing

- **WHEN** an agent lists an environment with many apps and configured infrastructure
- **THEN** the default answer SHALL be compact, SHALL contain the infrastructure section, and SHALL say how to ask for the full detail

#### Scenario: Infrastructure is required by an app

- **WHEN** an agent calls `env_start` for an infrastructure service a live lease attributes to app `customer-fe`
- **THEN** the tool SHALL refuse with "infrastructure X is started by app customer-fe's requirement; start that app instead"
