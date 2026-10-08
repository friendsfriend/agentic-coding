# Spec Delta

## Purpose

Durable agents build, start, inspect and stop their own environment instances
through owner-scoped tools with bounded, redacted output.

## ADDED Requirements

### Requirement: Owner-scoped environment capability

Every durable workflow run SHALL receive an environment capability bound to its owner; the server SHALL derive the owner from the capability and SHALL reject any request addressing another owner's instance.

#### Scenario: Cross-owner access

- **WHEN** a run of `workflow:a` calls `env_stop` for an app that only `workflow:b` runs
- **THEN** the server SHALL report that `workflow:a` has no such instance and SHALL NOT stop `workflow:b`'s instance

### Requirement: Environment tools for every durable run

Every durable run, including read-only runs, SHALL be offered `env_list`, `env_start`, `env_status`, `env_stop`, `env_build`, `env_test` and `env_logs`. These tools SHALL NOT be replayed after an interruption.

#### Scenario: Read-only verifier starts the app

- **WHEN** a read-only verifier run starts
- **THEN** its tool list SHALL contain the environment tools and SHALL NOT contain write or edit

#### Scenario: Start at capacity

- **WHEN** an agent calls `env_start` while the instance cap is reached
- **THEN** the tool result SHALL report `queued` with the queue position

### Requirement: Bounded and redacted output

Environment tool results SHALL be bounded in size and SHALL replace values from the configuration `.env` and secret action values with a redaction marker.

#### Scenario: Secret in logs

- **WHEN** an app logs the value of `ICON_APPLICATION_MASTERPASSWORD` and the agent calls `env_logs`
- **THEN** the result SHALL contain `«redacted:ICON_APPLICATION_MASTERPASSWORD»` instead of the value
