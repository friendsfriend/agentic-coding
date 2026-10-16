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

