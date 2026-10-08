# Design

## Context

`InfraService` (`environment/config.ts`) has no notion of tenancy. Endpoint
exports/bindings already exist as action values (`endpoint.<name>`) with
strategies documented in `docs/devenv/cross-runtime-endpoints.md`.
`DependencyLeases` refuse to stop a target with dependents.

## Goals / Non-Goals

**Goals:** per-instance schema for SQL databases; uniform infra/app endpoint
variables; reuse leases and endpoint strategies.

**Non-Goals:** Redis/broker/blob isolation (apps use their own key prefixes;
can be added as further `isolation.kind` values later), data seeding,
Kubernetes-specific endpoints (change 4 adds the in-cluster strategy).

## Decisions

- **Declarative isolation.** `isolation: { kind: "postgres-schema" |
  "mysql-database", admin: { host, port, user, passwordEnv?, database } }` on
  the infra definition. Hooks run with `Bun.sql` (no new dependency) using admin
  credentials from the config `.env`; credentials never enter instance
  variables or logs.
- **Naming.** `<app>_<instanceId>` lowercased, `-` → `_`, truncated to 63 bytes
  with a hash suffix. The `user` instance gets no provisioning and
  `AC_DB_SCHEMA` defaults to the app's own schema name declared in the target
  (`${AC_DB_SCHEMA:-customer}`), preserving today's behavior.
- **Lifecycle.** Provision after infra readiness, before the app starts
  (`CREATE SCHEMA IF NOT EXISTS`). Drop (`DROP SCHEMA ... CASCADE`) only when
  the instance is **removed**, not on a plain stop, so restarts keep data.
  Removal is what teardown/TTL (change 3) performs.
- **Infra variables.** Computed from the infra definition and the consumer's
  runtime: compose consumer → compose service name + container port; script
  consumer → `127.0.0.1` + published port. Cross-provider compose (docker vs
  podman) uses `host-published`, matching the existing strategy table.
- **App groups.** Resolution order for a binding to app `X`: same-owner
  instance of `X` → `user` instance of `X` → unresolved (start fails with a
  typed `binding-unresolved` naming `X`). No implicit start of `X`.
- **Leases.** An instance is a lease owner (`ownerRunId` = instance id), so
  infra stays up while any instance requires it.

## Risks / Trade-offs

- [Drop on removal deletes data the developer wanted] → only agent-owned
  instances are ever removed automatically; `user` instances are never
  provisioned or dropped.
- [Schema-unaware apps ignore `AC_DB_SCHEMA`] → validator/setup workflow
  (changes 5, 14) checks that templated targets reference it when they require
  an isolated infra.
