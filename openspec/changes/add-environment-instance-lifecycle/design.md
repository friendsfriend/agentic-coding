# Design

## Context

Workflow effects run through the durable outbox (`src/workflow/effect-runner.ts`).
`workspace.cleanup` already removes worktrees on delete. Slots and the stop path
come from `make-app-runs-exclusive`.

## Goals / Non-Goals

**Goals:** no agent-held app outlives its owner or its usefulness, so waiters
always make progress.

**Non-Goals:** caps (one run per app is the cap), priorities, releasing
human-held apps.

## Decisions

- **Teardown as a workflow effect.** `environment.teardown {owner}` is emitted
  on close and on delete, and calls the server's stop-by-owner operation. An
  unreachable server is an `infrastructure` failure, retried through the
  outbox. It is never recorded as a completed release.
- **Activity.** Writes are coalesced to one per app per 30 s. Waiting owners
  touch their held apps on each long-poll.
- **Reaper.** A server-scoped fiber runs every 60 s with an injected clock. It
  skips `unknown` apps, releases idle agent-held apps through the normal stop
  path, and the grant follows automatically. Each reap publishes
  `environment.slot.reaped {app, owner}` so the shell can show a toast.
- **No step-handoff release.** By decision, a workflow keeps its apps across
  steps (a verifier reuses what implementation started) until it stops them,
  ends, or idles.

## Risks / Trade-offs

- [A long thinking phase triggers the TTL] → every tool call touches activity,
  and the TTL is configurable.
