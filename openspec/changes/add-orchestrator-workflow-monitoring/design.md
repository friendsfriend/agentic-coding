# Design

## Context

The server publishes `workflow.*` events on `/api/v1/events` (bounded replay,
`resync` on gaps) and the shell already consumes them through
`subscribeDataEvents`. The orchestrator session lives in a detached durable host;
the shell writes its run env and can submit input with `whenBusy: "followUp"`.
The former Herdr developer-notification predicate was removed with the
multiplexer, so no reusable "owes developer input" helper exists in code.

## Goals / Non-Goals

**Goals:**

- Wake the orchestrator on meaningful transitions of the workflows it started.
- Tell the developer when a human review or question is waiting.
- Bounded cost: no wake-up storm, no wake-up for state that existed at first
  observation.

**Non-Goals:**

- Monitoring while no shell runs (the server lives in the shell).
- Monitoring workflows the developer started (follow-up if wanted).
- The orchestrator deciding anything new: it still only has its existing tools.

## Decisions

- **Shell-owned monitor, not host-owned.** The shell owns the server, the event
  stream and the session binding; the host would need a second server
  credential lifecycle. The monitor starts with the shell (independent of the
  page being open) and ensures the orchestrator host the same way the page does.
- **Pure detector.** `detectTransitions(previous, next)` over a small
  projection `{ status, stepId, reviewPending, questionPending, failedEffects,
  completed }` returns typed transitions. A workflow seen for the first time
  only records its projection. Human-review steps reuse
  `HUMAN_REVIEW_STEPS` from `orchestrator-policy.ts`.
- **Event → re-read.** Events carry only resource/run ids, so the monitor
  re-reads that one workflow's view (bounded, debounced per workflow) and diffs
  projections. A `resync` re-reads the orchestrator-started set.
- **Coalesced notes.** Transitions within a 10 s window become one note:
  `[workflow-monitor]` followed by one line per transition (workflow id, target,
  step, what changed). At most one note per 60 s per session; overflow is
  merged into the next note. Notes are submitted with `whenBusy: "followUp"`.
- **Notifications are independent of `monitor = "wake"`.** `notify` and `wake`
  both raise the shell notification for human-needed transitions.

## Risks / Trade-offs

- [A wake-up costs a model turn] → Coalescing and the per-minute bound; `notify`
  mode removes the cost entirely.
- [Events missed while the shell was closed] → First observation after start is
  a baseline only; the developer sees current state in the sidebar.
