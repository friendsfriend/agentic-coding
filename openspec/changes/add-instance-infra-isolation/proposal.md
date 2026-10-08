# Proposal

## Why

Instances (`add-environment-instances`) isolate app processes, but every copy
still points at the same infrastructure data. Two branches of one app running
Flyway/Liquibase migrations against one schema corrupt each other, and
templated definitions need a way to reach shared infra and sibling apps without
hardcoding container names or host ports. Infra must stay shared (one Postgres,
one Redis) to keep load low.

## What Changes

- Infra definitions may declare `isolation` (`postgres-schema`,
  `mysql-database`); the server provisions a per-instance schema/database when
  an instance that `requires` that infra starts, and drops it when the instance
  is removed. The name is exported as `AC_DB_SCHEMA`.
- Every instance receives `AC_INFRA_<SVC>_HOST` / `AC_INFRA_<SVC>_PORT` for
  each required infra service, with values matching the instance runtime
  (compose service DNS on `devenv-local`, `127.0.0.1` + published port for
  scripts).
- Instances of one owner form an **app group**: endpoint bindings resolve to the
  same owner's instance of the producer app, exported as
  `AC_APP_<APP>_<ENDPOINT>_URL`; when the owner has no instance of the producer,
  the binding falls back to the `user` instance.
- Infra keeps its existing lease semantics: started on first lease, stopped
  when the last lease is released.

## Capabilities

### New Capabilities

- `environment-infra-isolation`: per-instance DB isolation hooks, infra
  endpoint variables, and owner-scoped app-group endpoint resolution.

## Impact

- `src/server/environment/config.ts` (`InfraService.isolation`),
  `src/server/environment/instances/` (provisioning, variables),
  `src/server/runtime/leases.ts` (instance as lease owner),
  `src/server/actions/values.ts` (endpoint bindings).
- Tests: new `test/environment-infra-isolation.test.ts`, opt-in smoke against a
  disposable Postgres.
- Depends on `add-environment-instances`.
