# Tasks

## 1. Teardown

- [ ] 1.1 Add server route `POST /api/v1/environment/instances/remove {owner}` removing all instances (and provisioned schemas) of an owner; verify it never touches `user`.
- [ ] 1.2 Add the `environment.teardown` workflow effect emitted on close and delete, classified per `docs/workflow-effect.md`; verify in workflow runtime tests that an unreachable server retries and a success is recorded once.

## 2. Activity and TTL

- [ ] 2.1 Track and coalesce `last_activity_at`; verify coalescing.
- [ ] 2.2 Add the reaper fiber to the runtime service scope with injected clock; verify idle removal, `unknown` skip and `user` exemption.

## 3. Caps and queue

- [ ] 3.1 Add `instance_queue` and atomic cap checks for `max_total` and `max_kubernetes`; verify queued response with position, promotion on removal, expiry.
- [ ] 3.2 Add settings `environment.instances.{idle_ttl_minutes,max_total,max_kubernetes,port_range}` to config parsing and the settings view; verify defaults.

## 4. Checks

- [ ] 4.1 Document lifecycle and settings in `agentic-coding/docs/agent-environments.md` and `docs/config-inventory.md`.
- [ ] 4.2 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
