# Tasks

## 1. State

- [x] 1.1 Add schema v8 (`env_instances`, `port_allocations`) to `agentic-coding/src/server/environment/state-store.ts` with the existing backup/integrity path, and verify in `test/environment-state.test.ts` that v7 fixtures migrate, a v8 database reopens idempotently, and a future schema still fails closed.

## 2. Instance model

- [x] 2.1 Add `src/server/environment/instances/model.ts` (owner parsing, instance id slug, record types) as pure functions; verify id stability, sanitization and uniqueness in `test/environment-instances.test.ts`.
- [x] 2.2 Add the port allocator (`instances/ports.ts`): scan target source for `AC_PORT_<NAME>`, allocate from the injected range (production currently uses `20000-29999` until config parsing is wired), bind-check, persist, free on stop; verify allocation, reuse after free, exhaustion error and that `user` allocates nothing.
- [x] 2.3 Add template-variable resolution (`instances/variables.ts`) producing `AC_INSTANCE`, `AC_OWNER`, `AC_APP_DIR`, `AC_IMAGE_TAG`, `AC_PORT_<NAME>`; verify `user` vs agent owner values.

## 3. Execution

- [x] 3.1 Thread an instance context through `discoverActionTargets` (`localDir` = owner checkout) and the run compilers so compose runs with `-p <app>-<instance>` and the variables in its environment; verify the compiled argv/env in `test/runtime-app.test.ts`.
- [x] 3.2 Run script targets with the variables and an instance-tagged handle in `script-infrastructure.ts`; verify stop terminates only that instance's process tree.
- [x] 3.3 Implement runtime choice (docker → shell/systemshell, never kubernetes; profile `default` → single profile → error) and verify each branch.
- [x] 3.4 Detect untemplated targets (`container_name`, `include:` of infra compose) and refuse them for non-`user` owners with a typed error; verify.

## 4. API

- [x] 4.1 Add the instance routes (list, get, start, stop) with resolved endpoints and register them in the route ownership manifest; verify in `test/runtime-routes.test.ts` including `already-running` for a repeated start.
- [x] 4.2 Reconcile persisted instances against runtime observation on server start (unobservable → `unknown`); verify.

## 5. Checks

- [x] 5.1 Document the instance model and variables in `agentic-coding/docs/agent-environments.md`.
- [x] 5.2 Run `bun run lint`, `bun run type-check` and the focused tests in `agentic-coding/` with zero diagnostics.
