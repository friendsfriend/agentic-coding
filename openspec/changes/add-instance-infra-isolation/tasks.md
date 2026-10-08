# Tasks

## 1. Model

- [ ] 1.1 Add `isolation` to `InfraService` parsing/normalization in `src/server/environment/config.ts` with validation errors addressed to the definition file; verify in `test/environment-config.test.ts`.
- [ ] 1.2 Add schema/database naming (pure) and verify sanitization, truncation and hash suffix.

## 2. Provisioning

- [ ] 2.1 Implement provision/drop hooks over `Bun.sql` for `postgres-schema` and `mysql-database`, run after infra readiness and on instance removal; verify with an injected SQL port that statements are correct and admin credentials never appear in logs or variables.
- [ ] 2.2 Add an opt-in smoke test (`DEVENV_SMOKE_RUNTIME=docker`) against a disposable Postgres container that provisions and drops a schema.

## 3. Variables and groups

- [ ] 3.1 Export `AC_DB_SCHEMA`, `AC_INFRA_<SVC>_HOST/PORT` per consumer runtime; verify compose vs script values.
- [ ] 3.2 Resolve endpoint bindings within the owner's app group with `user` fallback and `binding-unresolved` failure; verify all three branches.
- [ ] 3.3 Register instances as dependency-lease owners in `src/server/runtime/leases.ts`; verify infra is stopped only after the last instance releases it.

## 4. Checks

- [ ] 4.1 Extend `agentic-coding/docs/agent-environments.md` with isolation and variable tables.
- [ ] 4.2 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
