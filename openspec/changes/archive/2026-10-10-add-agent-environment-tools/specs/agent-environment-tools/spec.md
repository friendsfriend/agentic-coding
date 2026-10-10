# Spec Delta

## Purpose

Durable agents build, start, inspect and stop their workflow's apps through
owner-scoped tools that wait for busy apps without model turns, with bounded
and redacted output.

## ADDED Requirements

### Requirement: Owner-scoped environment capability

Every durable workflow run SHALL receive an environment capability bound to its workflow owner; the server SHALL derive the owner from the capability and SHALL reject any attempt to stop or start on behalf of another owner.

#### Scenario: Stop of another workflow's app

- **WHEN** a run of `workflow:a` calls `env_stop` for an app held by `workflow:b`
- **THEN** the server SHALL refuse and `workflow:b`'s run SHALL keep running

### Requirement: Environment tools for every durable run

Every durable run, including read-only runs, SHALL be offered `env_list`, `env_start`, `env_status`, `env_stop`, `env_build`, `env_test` and `env_logs`, and these tools SHALL NOT be replayed after an interruption.

#### Scenario: Read-only verifier starts the app

- **WHEN** a read-only verifier run starts
- **THEN** its tool list SHALL contain the environment tools and SHALL NOT contain write or edit

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
