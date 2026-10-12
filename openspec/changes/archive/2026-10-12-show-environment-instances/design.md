# Design

## Context

The Environments feature renders apps and infra from the devenv CLI package.
The server publishes `environment.slot.{waiting,granted,reaped}` plus
start/stop events over `/api/events` with gap-detectable envelopes, and serves
`GET /api/v1/environment/apps/slots`.

## Goals / Non-Goals

**Goals:** see contention at a glance; unblock with one confirmed action.

**Non-Goals:** reordering the queue, starting apps for an agent, editing the TTL
inline (it lives in Settings).

## Decisions

- **Rows only for contention or agent holds.** Apps that are idle or held by
  `user` with no waiters stay in the normal app list, which keeps the section
  small.
- **Force release confirmation** names the holder, the next waiter, and states
  that the holder's run will be stopped. A human-held app can be released here
  too (it stops your own run).
- **Navigation** uses the sidebar's resolution rule (workflow target).
- **Keybinds.** `x` "force release app" (`short: release`) and `Enter` "open
  owning workflow" (`short: open`); navigation keys are `standard`.

## Risks / Trade-offs

- [The developer releases an app an agent is mid-test on] → the agent gets
  `released-by-developer` and can queue again. Accepted.
