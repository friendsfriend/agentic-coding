# Design

## Context

Workflow stores are per target; the target registry lists every target a
workflow was started in, which is exactly the set the sidebar reads. After
`attribute-orchestrator-actions`, every workflow pins `startedBy` and its creation
time is in the store.

## Goals / Non-Goals

**Goals:**

- A ceiling the session cannot talk its way past.
- A refusal the model can understand and relay ("3 of 3 active: a, b, c").

**Non-Goals:**

- Cost/token budgets (would need telemetry aggregation).
- Limiting operator starts or agent runs inside a workflow.
- Queueing a refused start for later.

## Decisions

- **Count at start time, in the server.** The count is read immediately before
  `operations.start`, under no new lock: two concurrent orchestrator starts can
  both pass at `max_active - 1`. The orchestrator issues tool calls one at a time
  through one session, so the race needs two shells or a parallel tool round;
  the overshoot is bounded by the parallelism and accepted.
- **Pure decision.** `orchestratorLaunchRefusal({ limits, active, recent })`
  lives beside the route/action policy and is unit-tested; `app.ts` only
  gathers counts.
- **Trailing 24 h, not calendar day.** No timezone dependency.
- **Read-only in Settings.** The ceiling is a guard the developer sets
  deliberately; it is not offered next to the model picker.

## Risks / Trade-offs

- [Counting reads every target store] → Bounded by the target registry; reads are
  observational and skip stores that need migration (counted as zero, with a
  diagnostic in the refusal text when any store was skipped).
