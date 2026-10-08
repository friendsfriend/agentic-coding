# Design

## Context

Workflow effects run through the durable outbox (`src/workflow/effect-runner.ts`);
`workspace.cleanup` already removes worktrees on delete. Instances live in the
environment state database owned by the server.

## Goals / Non-Goals

**Goals:** nothing agent-owned outlives its owner or its usefulness; bounded
load; observable queue.

**Non-Goals:** priority scheduling, per-owner quotas, preemption.

## Decisions

- **Teardown as a workflow effect.** `environment.teardown {owner}` is emitted
  on transition to `completed`-closed and on delete. It calls the server's
  remove-by-owner route. Failure is classified like any effect: an unreachable
  server is `infrastructure` (retryable through the outbox), never a confirmed
  removal.
- **Activity.** Any instance API call, tool call addressing the instance, or
  browser navigation to its endpoint (change 8) touches `last_activity_at`.
  Writes are coalesced to at most one per instance per 30 s.
- **Reaper.** Server-scoped fiber every 60 s removes agent-owned instances idle
  beyond the TTL. An instance whose runtime is `unknown` is skipped, not
  removed.
- **Caps and queue.** Checked atomically under the state write lock at start.
  Over cap → row in `instance_queue(seq, owner, app, target, requested_at)`;
  the start response is `queued {position}`. Every removal promotes the queue
  head(s) that now fit. Queued requests expire after 30 min without a poll.
  `max_kubernetes` counts only kind instances and also counts toward
  `max_total`.
- **Exempt `user`.** Human-started instances never count against caps and are
  never reaped; they still hold leases.

## Risks / Trade-offs

- [Long-running agent step idles while thinking] → TTL default 30 min and every
  tool call touches activity; tune via settings.
- [Queue starvation by a stuck instance] → TTL guarantees eventual release.
