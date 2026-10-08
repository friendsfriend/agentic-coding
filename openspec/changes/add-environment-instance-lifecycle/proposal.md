# Proposal

## Why

Agent-owned instances would otherwise live forever: a completed or deleted
workflow leaves containers, schemas and ports behind, and an agent that forgets
to stop an app keeps the machine loaded. Parallel workflows can also start more
instances than the machine can carry.

## What Changes

- Tie agent-owned instances to their owner: workflow completion, closure or
  deletion removes the owner's instances (and their schemas) through a durable
  workflow effect.
- Track `last_activity_at`; an idle reaper removes agent-owned instances idle
  longer than `environment.instances.idle_ttl_minutes` (default 30).
- Enforce caps `environment.instances.max_total` (default 6) and
  `environment.instances.max_kubernetes` (default 2); a start over a cap is
  queued FIFO and reports its position instead of failing.
- `user` instances are exempt from TTL, caps and teardown.

## Capabilities

### New Capabilities

- `environment-instance-lifecycle`: owner-bound teardown, idle TTL, caps and
  the start queue.

## Impact

- `src/server/environment/instances/` (reaper, queue), state v8 table
  `instance_queue` (extends the v8 migration if not yet released, otherwise v9).
- `src/workflow/effects.ts` + lifecycle step behavior (`src/workflow/steps/lifecycle.ts`)
  for an `environment.teardown` effect.
- Settings: `src/tui/settings/items.ts`, config inventory.
- Depends on `add-environment-instances`.
