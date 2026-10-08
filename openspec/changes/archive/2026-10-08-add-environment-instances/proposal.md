# Proposal

## Why

Configured run targets are singletons: compose files hardcode `container_name`,
host ports and `image: <app>:latest`, and the environment manager runs exactly
one copy per app from the active checkout. Parallel workflows working on the
same app in separate worktrees cannot each run and test their own code, and
agents have no addressable unit to start, observe or stop. Every later agent
capability (environment tools, browser, debug agent) needs an isolated,
owner-scoped app instance first.

## What Changes

- Introduce **environment instances**: one running copy of one app run target,
  owned by `user` or `workflow:<id>` (standalone debug, debug sub-agents and
  env-setup all run as workflows), bound to that owner's checkout path and an
  optional configuration overlay (used by `add-environment-setup-workflow`).
- Persist instances and port allocations in the environment state database
  (schema v8, migrated with the existing backup/integrity guarantees).
- Resolve **template variables** (`AC_INSTANCE`, `AC_OWNER`, `AC_APP_DIR`,
  `AC_IMAGE_TAG`, `AC_PORT_<NAME>`) for every run target; ports are allocated
  from a configured range for agent owners and fall back to the `:-default` in
  the definition for the `user` owner, so human-started apps keep today's ports.
- Run Docker compose targets as compose project `<app>-<instance>` on the
  shared external `devenv-local` network, and script targets with the template
  variables in their environment and an instance-tagged process/tmux handle.
- Agent-owned starts choose the runtime Docker compose → script when no target
  is named; kind is never chosen implicitly (handled in
  `add-kubernetes-environment-instances`).
- Add server routes to start, stop, list and read status of instances.

## Capabilities

### New Capabilities

- `environment-instances`: instance identity and ownership, persisted
  instances and port allocations, template-variable resolution, per-instance
  compose/script execution, runtime selection, and the instance API.

## Impact

- `agentic-coding/src/server/environment/state-store.ts` (v8 migration),
  new `src/server/environment/instances/` (model, allocator, templating).
- `src/server/actions/discovery.ts`, `compile.ts`, `target-compile.ts` (instance
  context in compiled definitions), `src/server/runtime/docker.ts`,
  `script-infrastructure.ts`, `app-routes.ts` / new instance routes.
- Tests: `test/environment-state.test.ts`, new `test/environment-instances*.test.ts`.
- No change to existing human TUI flows: the `user` instance reproduces today's
  names and ports when a definition is untemplated.
