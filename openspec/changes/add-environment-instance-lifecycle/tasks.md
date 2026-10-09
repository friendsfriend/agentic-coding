# Tasks

## 1. Teardown

- [ ] 1.1 Add a stop-by-owner server operation that never touches `user`-held apps; verify.
- [ ] 1.2 Add the `environment.teardown` effect, emitted on close and delete and classified per `docs/workflow-effect.md`; verify retry on an unreachable server and a single recorded success.

## 2. Activity and TTL

- [ ] 2.1 Track and coalesce `last_activity_at`, including touches from waiting owners; verify.
- [ ] 2.2 Add the reaper fiber with an injected clock; verify idle release, `unknown` skip, `user` exemption, grant to the next waiter and the `environment.slot.reaped` event.
- [ ] 2.3 Add the `environment.instances.idle_ttl_minutes` setting (default 30) to config parsing and the settings view; verify the default.

## 3. Checks

- [ ] 3.1 Document lifecycle and the setting in `agentic-coding/docs/agent-environments.md` and `docs/config-inventory.md`.
- [ ] 3.2 Run `bun run lint`, `bun run type-check` and the focused tests with zero diagnostics.
