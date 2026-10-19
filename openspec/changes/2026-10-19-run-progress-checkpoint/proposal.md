## Why

The engine has no notion of a run's progress. One worker run took 1,072 turns,
66.3814 units (15.0 % of the repaired 441.9321-unit corpus; the older documents
say "17 %" against the pre-repair 391.0161), peaked at 911,257 tokens of
context and then handed off `blocked`; its second half cost 43.2 units against
23.2 for the first. Four more long runs show the same 1.87–2.9× second-half
curve, the last three deciles of a long run carry ~42 % of its cost, and in the
repaired dataset the 40 runs of 150 turns or more carry 182.25 units — 41.2 % of
the corpus. The context half of the problem is shipped (the cost-aware
compaction ceiling, backlog item 6); the missing half is a point where someone
looks at a long run and decides what happens next.

A raw turn ceiling is the wrong instrument: the repaired dataset shows
*successful* worker runs of 704, 886 and 1,010 turns, so any turn count low
enough to matter would cut real work off. The developer's requirement is
explicit — a turn count never stops or blocks a run; only a recorded decision
does, and a stop always reaches the developer as a normal developer question.

## What Changes

- Add a **run-progress checkpoint** to the durable agent host. It fires at a
  soft per-role-class threshold (turns or measured context) and earlier on an
  objective stall signal measured from the run's own telemetry (the same tool
  failing repeatedly, exact repeats of earlier calls, no file change / no task
  tick / no commit for a window, cost per turn rising without progress, diff
  size). It never fires for a session without a run id.
- The checkpoint is a **decision over a fixed option set** — `continue`,
  `steer`, `compact`, `switch-model`, `escalate` — taken from a structured,
  content-free signal digest. The first release decides with a transparent,
  deterministic **rule set** (same digest → same decision) whose default is
  `continue`; `escalate` fires only on clear stall evidence, on two consecutive
  zero-progress checkpoints, on an ignored steer, or at the per-role hard limit.
- `steer` delivers one **fixed, pre-written nudge** per signal from a closed
  catalog; the decider never writes free text. `compact` reuses the existing
  ceiling-compaction admission path. `switch-model` is part of the vocabulary
  but no first-release rule selects it and the applier does not act on it.
- `escalate` files a **normal developer question** on the run's behalf with a
  plain, templated summary of the digest; the run is parked (`blocked` with the
  question pending) only when the question was actually recorded and is still
  unanswered after the agent grace window — the existing asker-resume path
  re-issues the run when the developer answers. Cancelling the question is the
  developer's stop.
- **Fail-open everywhere**: an evaluation error, a timeout, missing data, a
  failed record write or a question that could not be filed means the run
  continues and the event is recorded. Nothing in this change can block a run
  without a developer question.
- Every checkpoint is recorded: one classifier decision record per decision
  (integration `progress-checkpoint`, same record shape as routing/triage/gate)
  through a new authenticated run command, and one `runtime.checkpoint`
  telemetry envelope; `runtime.settled` additionally carries the run's cost
  units and checkpoint count.
- **Measurement first**: a `turn-distribution` efficiency query computes turns
  per role class (all runs and successful runs) from the repaired dataset and the
  defaults are pinned from it by a stated formula; `run-progress`,
  `progress-checkpoints` and `checkpoint-gaps` (the alarm: a run above its soft
  threshold with no decision) verify the effect, and an offline replay runs the
  same rule module over recorded runs.
- The later swap-in of the existing classifier as the decider (and an optional,
  off-by-default LLM advisor) is **specified but not implemented** here; it is
  drafted as the follow-up change `2026-10-19-classifier-checkpoint-decider`.
- No store schema change (`STORE_SCHEMA_VERSION` stays 6), no migration, no
  compatibility shim, and no change to when a workflow otherwise blocks.

## Capabilities

### New Capabilities

- `run-progress-checkpoint`: the soft/hard thresholds and stall signals, the
  content-free signal digest, the fixed decision vocabulary and the
  deterministic rule set, the fixed steer catalog, the escalation-as-developer-
  question contract, fail-open behaviour, the per-run decision records and
  telemetry, and the measurement and verification queries.

### Modified Capabilities

None. The decision records use the integration-keyed history that
`classifier-decision-records` already specifies for "a classifier integration
other than routing"; the escalation uses the `workflow-developer-question`
contract and its asker-resume requirement unchanged; the compaction it
triggers is the `durable-agent-compaction` ceiling path with an additive kind.

## Impact

- `src/agent-host/progress-checkpoint.ts` (new, pure: signal accumulator,
  digest, rule set, steer catalog, escalation text), `src/agent-host/host.ts`
  (wiring through the existing `onMeasuredContext`/`onToolOutcome` hooks, the
  `steer` submit mode, the ceiling-compaction admission, the run's own
  `workflow question` / `workflow handoff` CLI calls), `src/agent-host/telemetry.ts`
  (argument hash and mutation flag on the tool observation; cost units and
  checkpoint count on `runtime.settled`), `src/agent-host/tools.ts` (CLI helpers).
- A new authenticated run command (`workflow checkpoint`) and its reducer that
  appends one decision record to `snapshot.classifierDecisions` without any
  lifecycle transition; `src/tui/dash/projections.ts` gains a one-line outcome
  for the new integration.
- `[agents.checkpoint]` configuration (enable, steer on/off, per-role-class
  overrides) in `src/workflow/profiles.ts` validation.
- `scripts/efficiency/lib/queries.ts` (four queries), a replay script, the query
  tests, and an addendum `docs/efficiency/04b-run-progress-checkpoint.md` with
  the measured distribution and pinned defaults; `docs/workflow-architecture.md`
  gains the checkpoint section.
- `STORE_SCHEMA_VERSION` stays 6; no migration; the older efficiency documents
  are not rewritten.
