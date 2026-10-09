# Proposal

## Why

With one run per app (`make-app-runs-exclusive`), an app an agent forgets to
stop blocks every other workflow that needs it. Agent-held apps must be
released when the owner no longer exists and when nobody uses them.

## What Changes

- **Workflow-bound release:** when a workflow is closed or deleted, a durable
  `environment.teardown` effect stops every app it holds, which grants the next
  waiter.
- **Idle TTL:** the server tracks `last_activity_at` per held app. An
  agent-held app idle longer than `environment.instances.idle_ttl_minutes`
  (default 30) is stopped and released. Apps held by `user` are never reaped.
- Activity is any agent operation on the app (env tools, browser navigation to
  its endpoint, debug tools). Apps held by an owner that is waiting for other
  apps also count as active.
- The setting appears in Settings and the configuration inventory.

## Capabilities

### New Capabilities

- `environment-instance-lifecycle`: owner-bound release and idle TTL for
  agent-held apps.

## Impact

- `src/server/runtime/instances.ts` (activity, reaper fiber),
  `src/workflow/effects.ts` + `src/workflow/steps/lifecycle.ts`
  (`environment.teardown`), settings (`src/tui/settings/items.ts`),
  `docs/config-inventory.md`.
- Depends on `make-app-runs-exclusive`.
