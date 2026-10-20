## Context

Backlog item 19 (`docs/efficiency/04-backlog.md`) proposed a turn/context
ceiling that stops a run and hands off `blocked`. The developer rejected the
stop: tasks must never be blocked at random, a raw turn count must never stop
or block a run, a run is only ever stopped by a *decision*, and a stop always
reaches the developer as a normal developer question with a plain summary.
This design replaces the ceiling with a recorded, fail-open checkpoint
decision.

Figures. Every share in `03-synthesis.md`/`04-backlog.md` is a lower bound
against 391.0161 units; `04a-harness-reader-repair.md` repaired the denominator
to **441.9321 units, 34,711 preferred turns, 26,847 preferred calls, 1,259
runs**. Re-expressed against that (old documents are not rewritten):

| figure | old text | repaired |
| --- | --- | --- |
| the 1,072-turn worker run | 66.3814 units, "17 % of the corpus" | 66.3814 units = **15.0 %** |
| its halves | 23.165 / 43.217 units | unchanged (absolute) |
| mean worker turns per run | 106.8 | **106.1** (14,637 turns / 138 worker runs) |
| runs ≥ 150 turns | — | 40 runs, 182.25 units = **41.2 %** |
| worker runs ≥ 250 turns | — | **22.7 %** of the corpus |
| last three deciles of a long run | ~42 % of that run | unchanged (within-run ratio) |

Turn distribution per role class, measured during planning from the pinned
snapshot rebuilt into a temporary directory (`build-dataset.ts --evidence
~/agentic-coding-efficiency-evidence/latest --out $(mktemp -d)`, read-only on
the evidence). "Successful" = an `agent.handoff` with outcome `complete` or a
run status `complete`/`completed`; only 73 of the 944 runs with turns carry a
known outcome, so the successful columns are small samples.

| class | runs | p50 | p90 | p95 | p99 | max | successful n | successful p99 / max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| worker | 117 | 76 | 242 | 374 | 886 | 1,072 | 14 | 886 / 1,010 |
| planner (`planner*`, `consolidator`) | 212 | 15 | 56 | 63 | 90 | 166 | 3 | 122 / 166 |
| verifier (`*-verifier`) | 383 | 16 | 65 | 89 | 192 | 228 | 42 | 204 / 228 |
| mechanical (`triage`, `archive`, `wiki`, `git`) | 218 | 6 | 28 | 38 | 110 | 188 | 14 | 82 / 114 |

Two facts shape everything below. Successful worker runs reach 704, 886 and
1,010 turns (at 0.27–0.70 units each), so a turn count is not a cost and not a
failure signal; and the expensive outlier (66.4 units, 1,072 turns) would not
be caught by any turn limit above the successful p99. What distinguishes it is
*lack of progress while cost per turn rises* — which is what the checkpoint
measures.

Current seams, read in the code:

- The durable agent host (`src/agent-host/host.ts`) already supervises every
  run live: `attachTelemetry` hooks give one `onMeasuredContext` per committed
  turn and one `onToolOutcome` per finished call (tool, ok, failure kind,
  turn); the fail-fast monitor (`fail-fast.ts`, backlog item 3) is a precedent
  for a per-run, pure-module supervisor that reads only that telemetry.
- `AgentHost.submit(runId, text, requestId, "steer")` interrupts the running
  turn at its boundary; the compaction ceiling admits a compaction through a
  serialized path with a floor and a loop guard; `configureRun` applies a live
  model override (the dashboard's `/model`); the host can run the run's own
  `workflow handoff` / `workflow question` CLI with the run's capability
  (`runWorkflowCli`, used by the fail-fast and abort handoffs).
- `runtime.settled` already carries `turns` and `peakContextTokens`.
- Decision records (`classifier-decision-records`) are integration-keyed and
  bounded (100 records, 160 KiB, 16 KiB input per record) and the dashboard
  classifier panel lists every integration generically.
- A developer question that is still pending after the agent grace window
  (`AGENT_QUESTION_WAIT_MS`, 120 s) leaves the run to hand off `blocked`; the
  answer re-issues the asking run with the answer as prior dialogue
  (`resumeBlockedAsker`); a cancelled or expired question does not resume it.

## Goals / Non-Goals

**Goals:**

- A per-run checkpoint that fires at a soft threshold and earlier on objective
  stall signals, and decides among `continue`, `steer`, `compact`,
  `switch-model`, `escalate`.
- A deterministic, transparent first-release decider (rules), recorded in the
  same decision-record format the classifier integrations use, so a later
  classifier decider can be compared against it on recorded data.
- Escalation only through a normal developer question; fail-open on every error.
- Measurement first: defaults pinned from the repaired dataset by a stated
  formula, and queries that verify the targets: no run above the hard limit
  without a recorded escalation, second-half/first-half cost ratio < 1.3 for
  runs past the soft threshold, mean worker turns not above the repaired
  baseline (106.1).

**Non-Goals:**

- Stopping or blocking a run on a turn count, a context size or a cost.
- Implementing the classifier decider or an LLM advisor (specified as the
  follow-up draft `2026-10-19-classifier-checkpoint-decider`).
- Acting on `switch-model` (vocabulary only, see D9).
- Reading prose: the run's own text, tool arguments, results, or file contents
  never reach the decider.
- A Settings TUI page for `[agents.checkpoint]` (configuration file only here).
- Any store schema change, migration, compatibility shim, or change to when a
  workflow blocks for any other reason.

## Decisions

### D1. The checkpoint lives in the agent host, its record in the engine

The host is the only component that sees every turn and tool outcome while the
run is alive and that owns the actions (`steer` submit, compaction admission,
abort, the run's own CLI). A pure module `src/agent-host/progress-checkpoint.ts`
holds the signal accumulator, the digest, the rule set, the steer catalog and
the escalation text; `host.ts` only feeds it from the existing hooks and applies
its decision, exactly as it does for `ToolSurfaceMonitor`. The engine keeps the
durable decision history through a new authenticated run command (D8), so the
record lives in engine-owned state and appears in the existing decision panel.

*Alternatives:* engine-side evaluation on a timer — rejected, the engine sees a
run only at handoff and would need live telemetry it does not have; a pi
extension inside the agent — rejected, it would run in the agent's own process
and could be steered by the agent's context.

### D2. Thresholds per role class, declared by the step, configurable

A run's class is declared by its registered step behavior (`worker`,
`planner`, `verifier`, `mechanical`; anything undeclared is `other`, which uses
the worker values) and passed to the host in the run environment
(`HERDR_CHECKPOINT_CLASS`), so the host never keeps a role table of its own
(workflow-architecture rule: role knowledge belongs in `src/workflow/steps/`).
A session without `HERDR_RUN_ID` (the orchestrator) gets no checkpoint.

Configuration `[agents.checkpoint]`: `enabled` (default `true`), `steer`
(default `true`), `contextTokens` (default 200,000), and per-class tables
`[agents.checkpoint.<class>]` with `softTurns` and `hardTurns`. Validation:
integers, `softTurns ≥ 10`, `hardTurns ≥ 2 × softTurns`; an invalid table is a
configuration error at load, like the compaction section.

### D3. Per-role defaults (open decision — recommendation)

Formula, applied by task 1 to the latest snapshot:

- `softTurns` = p90 of all runs of the class with turns, rounded **up** to 10;
- `hardTurns` = max(5 × soft, 1.2 × successful p99, 1.2 × all-runs p99),
  rounded **up** to 50 — so the hard limit always sits above the 99th
  percentile of successful runs (the developer's constraint) and above the
  all-runs p99 where the successful sample is small;
- checkpoint interval after the first checkpoint = max(10, soft / 2).

Provisional values from the planning measurement:

| class | softTurns | hardTurns | interval | hard vs successful max |
| --- | ---: | ---: | ---: | --- |
| worker (and `other`) | 250 | 1,250 | 125 | 1,250 > 1,010 |
| planner | 60 | 300 | 30 | 300 > 166 |
| verifier | 70 | 350 | 35 | 350 > 228 |
| mechanical | 30 | 150 | 15 | 150 > 114 |

`contextTokens` = 200,000 for every class: above the shipped 150,000 compaction
ceiling, so it fires only when ceiling compaction did not hold the context.

*Assumption, stated:* the "above the 99th percentile of successful runs" rule
binds every threshold that can escalate **without** a stall signal — the hard
limit. The soft threshold only starts evaluation and its default answer is
`continue`, so it is placed at p90 (≈ 10 % of runs evaluated) rather than above
the successful p99; this is lower than the ~150-turn starting point only for
planners, verifiers and mechanical steps and higher (250) for workers, because
the measured worker p90 is 242. If task 1's measurement moves a value, the
formula wins over this table.

### D4. Signals, measured from telemetry only

The host accumulates per run (no text retained):

| signal | measured as | early trigger (from turn 30, cooldown = interval) |
| --- | --- | --- |
| turns, cost units | turn index; sum of `usage.cost.total` | — |
| context | last measured prompt tokens, peak | ≥ `contextTokens` |
| failing tool | consecutive failed calls of one tool, after ≥ 1 successful call in the run | ≥ 5 |
| exact repeats | share of the last 20 calls whose (tool, argument hash) was already seen in the run | ≥ 60 % |
| no progress | turns since the last progress event | ≥ 40 |
| cost rising | mean cost/turn over the last interval ÷ mean over the run's first half, with zero progress in the interval | ≥ 1.5 |
| diff size | `git diff --shortstat HEAD` numbers (files, insertions, deletions), sampled at checkpoints only, 2 s timeout | — |

A **progress event** is any of: a successful `edit`/`write` call; a change of the
sampled diff numbers; a new `HEAD` (a commit); an increase of the ticked-task
count of the assigned change's `tasks.md` (host-side count of `- [x]` lines,
only the number leaves the function); for a read-only run, a call whose
(tool, argument hash) is new in the run. The failing-tool signal is disabled for
the fail-fast exempt roles (`FAIL_FAST_EXEMPT_ROLES`: `env-setup`, `debug`) and
never applies to a run with zero successful calls, which fail-fast owns.

"Whether the run states it is converging" is **not** a first-release signal:
the run's prose is not trusted input. Convergence is derived (progress events
present and cost per turn not rising).

### D5. The rule set (first-release decider, deterministic)

Evaluated on the digest only; ordered; first match wins. Decider id `rules/v1`.

1. `hard-limit` — turns ≥ hardTurns → `escalate`.
2. `no-progress-twice` — the previous checkpoint decided `continue` with zero
   progress in its window and this window has zero progress → `escalate`.
3. `steer-ignored` — a signal that was already answered with a `steer` in this
   run is present again → `escalate`.
4. `context` — context ≥ `contextTokens` and a compaction is admissible (the
   ceiling's floor and loop guard allow it) → `compact`; not admissible → fall
   through (context alone never escalates).
5. `failing-tool` → `steer` (`failing-tool` nudge).
6. `repeats` → `steer` (`stop-rereading`).
7. `no-progress` → `steer` (`make-the-change`, or `conclude` for a read-only run).
8. `cost-rising` → `steer` (`converge`).
9. `default` → `continue`.

With `steer = false`, rules 5–8 yield `continue` (attention "steer disabled")
and rule 3 cannot apply; rules 1–2 still escalate. The previous decision and the
already-steered signals are part of the digest, so the same digest always
yields the same decision.

### D6. `steer` is a fixed catalog (open decision — in the first release)

Recommendation: ship `steer`, because without it every stall goes straight to
the developer. The catalog is closed and versioned; the only variable parts are
digest numbers:

- `failing-tool`: "Progress checkpoint: the last {n} calls of `{tool}` failed. Stop retrying it unchanged — read the error and change the approach, or hand off blocked naming the error."
- `stop-rereading`: "Progress checkpoint: {pct} % of your recent calls repeat calls you already made. Stop re-reading and make the next concrete change now (write the code or the tests)."
- `make-the-change`: "Progress checkpoint: no file change, commit or ticked task in the last {n} turns. Make the next concrete change now, or hand off blocked with what is in the way."
- `conclude`: "Progress checkpoint: the last {n} turns made no new call. Conclude from what you have read and write your result now."
- `converge`: "Progress checkpoint: cost per turn is rising without new changes. Finish the remaining tasks or hand off with the list of what remains."

`{tool}` is a registered tool name (an unknown name renders as `a tool`). Each
signal is steered at most once per run (D5 rule 3). The message is submitted
with the host's `steer` mode so it lands at the next turn boundary, never inside
a running tool call.

### D7. `escalate` is a normal developer question (one per escalation)

The host files the question **as the run** (`workflow question`, run
capability, the existing bounded wait) with a templated, plain summary: role,
step, turns vs soft/hard, cost units, context, the signals present, progress
since the last checkpoint, the rule that fired. Options: `continue` ("Let the
run continue") — the custom-text response carries direction; the question's
context states that **cancelling the question stops the run**. Outcomes:

- answered within the grace window → the run keeps its session; a fixed
  message (plus the developer's custom text, wrapped as untrusted
  developer-provided content) is submitted with `steer`; the run's escalation
  baseline resets (no-progress counter cleared, the hard limit re-arms at the
  current turn plus `softTurns`);
- cancelled within the grace window → the host stops the conversation at a turn
  boundary and records the run's `blocked` handoff naming the cancelled
  checkpoint question — the developer's stop;
- still pending after the grace window → the host stops the conversation at a
  turn boundary and records the run's `blocked` handoff naming the pending
  question; the existing asker-resume re-issues the run when the developer
  answers (cancelling leaves the workflow `attention-required` for repair);
- the question could not be filed (bounds, capability, CLI error) → the run
  continues; `runtime.checkpoint_escalation` records `filing-failed`;
- the run hands off on its own meanwhile → nothing more is done.

*Open decision — grouped note vs one question per escalation.* Recommendation:
one question per escalation, at most one open checkpoint question per run.
Answers resume runs one asker at a time, so a grouped note across runs would
either need new resume semantics or answer several runs with one choice.

*Alternatives:* keep the session paused in the host while the question is
pending — rejected for the first release: it needs a new host-side paused state
that the engine sees as `working` with an idle conversation, which the
reconcile path does not model; re-issuing through the existing asker-resume
costs a re-orientation but changes no lifecycle.

### D8. One decision record per checkpoint, same format

A new run command `workflow checkpoint --record <json>` (authenticated with the
run capability, refused for a run that is not active, bounded input) appends one
`ClassifierDecisionRecord` and commits an `agent.checkpoint` event with no
transition. Field mapping, all within the existing schema:

- `integration`: `progress-checkpoint`; `phase`: the step id;
  `questionId`: `checkpoint:<runId>:<ordinal>`; `model`: the decider id
  (`rules/v1`);
- `input`: the canonical JSON digest (≈ 1 KiB, under the 16 KiB bound);
- `options`: the five labels, each with `profile` = its label and `criteria` =
  its one-line description;
- `answer`: `choice` with the chosen label and one-hot `probabilities`; no
  `confidence` (rules have none);
- `result`: `applied`, `profiles` = [the action actually applied], `attention`
  = `rule <id>` plus any fail-open or not-applied reason.

Bounds: the decision history is shared (100 records), so a run writes at most
12 checkpoint records; later checkpoints are telemetry-only (`recorded: false`).
The `runtime.checkpoint` envelope carries the same digest, options, answer and
result for every checkpoint, so telemetry is the complete record and the
history the bounded, reviewable one. The dashboard outcome line for the
integration reads `decided <label> (rule <id>)`.

### D9. `compact` reuses the ceiling path; `switch-model` is vocabulary only

`compact` is admitted through the same serialized admission as the cost ceiling
(same summarizer, no instructions, same floor and loop guard); its compaction
envelope carries the additive kind `auto-checkpoint` and `runtime.settled`
counts it. `switch-model`: a seam exists (`configureRun`, the dashboard
`/model` override), but no safe target policy does — the target's window must
hold the current context, its provider must have credentials, and the step's
pool semantics would be bypassed. No first-release rule selects it; if a future
decider does, the applier records `applied: false` ("switch-model not enabled")
and continues.

### D10. Fail-open everywhere

Every evaluation runs inside a guard: an exception, a missing measurement, a
`git` timeout, a record command failure or a question that cannot be filed ends
as `continue` (or "keep going") and a `runtime.checkpoint` envelope with
`status: "error"` and a bounded error class. A failed record write does not
cancel an action that is otherwise safe (`steer`, `compact`); an escalation
parks a run only after its question was recorded.

### D11. What the classifier can and cannot do here (for the follow-up)

Read in `src/workflow/classifiers.ts`: a `choice` answer carries `choice`,
`probabilities` and `confidence`; selection takes the explicit choice, else the
most probable offered label, else the tagged default; **`confidence` is recorded
but never consulted** (confidence gating was removed); a `noul` answer carries no
confidence (triage uses a fixed 0.5 floor); a missing or malformed answer parses
as a value-less `noul`, i.e. "no answer → default". It reads a bounded text
state and never writes free text. It therefore cannot abstain in a calibrated
way, so "low confidence ⇒ escalate" is not available; a classifier decider must
fall back to the rule decision on no answer, and any abstention must be an
explicit option or a probability-margin rule in code pinned from recorded data.
It never sees file contents here because its input is the digest.

### D12. Rules are the decider at ship time (open decision — recommendation)

Rules ship as the default and only decider. The classifier becomes eligible as
the default only when replaying recorded checkpoints shows it beats the rules on
recorded runs; the comparison, the acceptance bar and the optional off-by-
default LLM advisor are specified in the follow-up draft
`2026-10-19-classifier-checkpoint-decider`. Recording the rule decisions in the
classifier record format now is what makes that comparison possible.

### D13. Telemetry, alarm and queries

- `runtime.checkpoint` (one per checkpoint): ordinal, trigger, class, turns,
  cost units, context and peak, signal numbers, decision, rule, applied,
  decider, latency, `recorded`, `status`.
- `runtime.checkpoint_escalation`: question id and outcome (`answered`,
  `cancelled`, `pending-parked`, `filing-failed`).
- `runtime.settled` gains `costUnits`, `checkpoints`, `checkpointEscalations`.
- Queries in `scripts/efficiency/lib/queries.ts`: `turn-distribution` (task 1),
  `run-progress` (per run: class, turns, cost, peak context, second-half /
  first-half cost ratio, outcome, above soft/hard), `progress-checkpoints`
  (decisions by class × decision × rule, escalations per 100 runs, progress after
  a steer), `checkpoint-gaps` (**the alarm**: runs whose turns passed their soft
  threshold with no checkpoint envelope, or with only `status: "error"`).
- `scripts/efficiency/replay-checkpoint.ts`: feeds recorded turns and calls
  into the same pure module and prints the decisions it would have made, with
  the share of calls that carry an argument hash (the repeats signal is blind
  without it).

## Risks / Trade-offs

- [Only 73 of 944 runs carry a known outcome; successful samples of 3–42 runs]
  → the hard limit takes the max with the all-runs p99, the hard limit only
  escalates, and task 1 re-measures on the latest snapshot.
- [A false escalation spends developer attention] → escalation needs a clear
  stall pattern, two zero-progress windows, an ignored steer, or the hard limit;
  `progress-checkpoints` reports escalations per 100 runs and the replay shows
  how often the rules would have escalated the cheap 704–1,010-turn successes.
- [A parked run is re-issued as a new attempt and re-orients] → only when the
  developer did not answer within the grace window; an answer inside it keeps
  the session.
- [`steer` mode interrupts the running turn] → submitted at the boundary the
  host already uses; tests assert no tool call is cut.
- [Checkpoint records evict routing records from the shared history] → 12 per
  run cap; telemetry holds the rest.
- [The tasks.md tick count and `git diff --shortstat` read the worktree] → only
  numbers leave the helper, sampled at checkpoints only, 2 s timeout, fail-open.
- [The 1,072-turn outlier is below the worker hard limit] → it is caught by the
  stall rules, not the limit; the replay over that run is part of task 1's
  evidence, with its argument-hash coverage stated.
- [Interaction with fail-fast and the compaction ceiling] → failing-tool needs a
  prior success (fail-fast owns zero-success runs); `compact` obeys the
  ceiling's floor and loop guard.

## Migration Plan

None: no schema version change, no stored-data change, no shim. The checkpoint
ships enabled with the rule decider; rollback is `[agents.checkpoint] enabled =
false` (or reverting the change). Stored workflows without checkpoint records
read as before.

## Open Questions

- Should a `hard-limit` escalation park the run immediately instead of after the
  grace window? (Recommendation: no — same path for every escalation; revisit
  with `progress-checkpoints` data.)
- Is "any later recurrence of a steered signal escalates" too strict for very
  long successful runs? (Recommendation: keep; the replay in task 1 shows the
  count, and the developer's `continue` resets the baseline.)
- A Settings page for `[agents.checkpoint]` — left for a later change.
