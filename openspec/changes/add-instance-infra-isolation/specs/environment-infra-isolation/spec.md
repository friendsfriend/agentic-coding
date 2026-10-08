# Spec Delta

## Purpose

Shared infrastructure with per-instance database isolation and uniform
endpoint variables, so concurrent instances never share migrated data and
templated definitions never hardcode infra or sibling-app addresses.

## ADDED Requirements

### Requirement: Isolated infra provisions a schema per instance

When an agent-owned instance requires an infra service declaring `isolation.kind` `postgres-schema` or `mysql-database`, the server SHALL create a schema or database named from the app and instance id before the app starts, export its name as `AC_DB_SCHEMA`, and drop it when the instance is removed. The `user` instance SHALL NOT be provisioned or dropped.

#### Scenario: Two branches migrate independently

- **WHEN** two workflow instances of the same app start against the shared Postgres
- **THEN** each SHALL receive a distinct `AC_DB_SCHEMA` that exists before its app starts

#### Scenario: Stop keeps data, removal drops it

- **WHEN** an agent-owned instance is stopped and later removed
- **THEN** its schema SHALL survive the stop and SHALL be dropped on removal

### Requirement: Infra endpoints are exported per consumer runtime

Every instance SHALL receive `AC_INFRA_<SVC>_HOST` and `AC_INFRA_<SVC>_PORT` for each required infra service, resolved for the instance's runtime, and admin credentials used for provisioning SHALL NOT appear in instance variables, tool output or logs.

#### Scenario: Script consumer

- **WHEN** a script instance requires `postgres`
- **THEN** `AC_INFRA_POSTGRES_HOST` SHALL be `127.0.0.1` and `AC_INFRA_POSTGRES_PORT` the published host port

### Requirement: App-group endpoint resolution

An endpoint binding to another app SHALL resolve to the same owner's instance of that app, otherwise to the `user` instance, otherwise the start SHALL fail with `binding-unresolved` naming the producer app.

#### Scenario: Frontend binds to its own workflow's backend

- **WHEN** `workflow:a` runs `customer-fe` and `customer-mw`
- **THEN** `customer-fe`'s backend URL variable SHALL point at `workflow:a`'s `customer-mw` instance

### Requirement: Shared infra stays up while any instance requires it

Each instance SHALL hold a dependency lease on its required infra; infra SHALL be stopped only when the last lease is released.

#### Scenario: One of two instances stops

- **WHEN** two instances require `postgres` and one is stopped
- **THEN** `postgres` SHALL keep running
