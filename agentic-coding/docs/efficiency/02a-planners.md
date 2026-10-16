# Step 2a — Planners and plan consolidation

Analysis of how the `planner` role (single-planning `core.plan`) and the fusion
planning pipeline (`planner-1..3` + `consolidator`) spent their turns, calls and
money in the pinned evidence snapshot. This is a report: it changes no
production code and requires no fix. All ids are dataset ids; no transcript text,
tool argument or tool result is reproduced here.

## Summary

Slice: 211 preferred run rows across 194 workflows, 4,496 turns, 3,791 tool
calls, **92.70 cost units** — 23.7% of the snapshot's 391.02 units and 13.6% of
its 33,137 turns. 96% of the slice cost sits in July+August (104 rows).

1. **Half of the measurable planner spend happens before the plan's first
   artifact exists.** For the 152 `core.plan` rows, 51 wrote at least one
   artifact: 1,004 of 2,246 turns (44.7% of all planner turns; 51.6% of the
   1,944 turns in those 51 runs) and **8.2161 of 16.1897 units (50.7%)** fall
   before the first `write`/`edit`. In the only planner run whose arguments
   survive (`9d73b931-…`), the first write lands at turn 31 of 56 and the
   orientation half holds 46% of that run's cost. — Finding F1.
2. **Planners explore through the shell, not the tools built for it.** 1,621
   `bash` calls against 908 `read` calls in `core.plan`, and **zero** `grep`
   calls in the whole slice; ~46 of the 55 shell calls in the observable run
   were single-purpose `ls`/`cat`/`grep`/`sed`/`find`/`wc`/`head`. — F2.
3. **74% of planner turns make exactly one tool call** (1,598 of 2,153 turns in
   the 59 call-visible `core.plan` runs) while the runtime clearly supports
   several per turn (21.6% of turns make 2+). — F3.
4. **Fusion's cost is the consolidator's model, not the 3× planners.**
   `planner-1..3` total 3.28 units (16 runs); the consolidator totals 12.98
   units, of which **12.91 (99.5%) is two `pi-copilot-opus` runs**
   (`b9904cce-…` 8.837, `e3ca1a7a-…` 4.072). With cheap consolidators the whole
   3-planner pipeline costs 0.002–0.068 units per workflow. `b9904cce-…` was
   rejected twice by the developer (two `developer.action` events), ran 80 turns
   / 8.837 units, and the workflow then idled 3 h 36 m. — F4.
5. **The same amount of planner work costs 41–43× more on a premium preset.**
   Three runs with the identical shape — 27 turns each — cost 1.714
   (`pi-copilot-opus`), 0.042 (`pi-gpt-5.6-luna`) and 0.040
   (`pi-copilot-luna`). — F5.

Not finding waste in: repeated calls (no duplicate survives in the slice, 0
groups), `openspec` validate loops (engine `openspec.validate` appears twice,
attempt 1, no retries), compaction (no planner-slice run ever compacted), cache
behaviour (98.3% hit rate). Those are listed under *Justified* and *Data limits*.

## Slice and method

**Definition.** `v_runs.role IN ('planner','planner-1','planner-2','planner-3',
'consolidator')`, all steps and both eras, preferred rows only. Plan-related
gates and events (`plan_quality_passed|rejected|issue`,
`developer_review_comment(s)_received`, `developer.question.created|answered`),
and the routing classification of the plan pool are read as context.

| group | rows | turns | calls | cost units | share |
| --- | --- | --- | --- | --- | --- |
| `planner` (`core.plan` 152 + step-less 37) | 189 | 3,961 | 3,043 | 76.44 | 82.5% |
| `planner-1..3` (`fusion.plan`) | 16 | 318 | 474 | 3.28 | 3.5% |
| `consolidator` (`fusion.consolidate`) | 6 | 217 | 274 | 12.98 | 14.0% |
| **slice** | **211** | **4,496** | **3,791** | **92.70** | 100% |

**Discrepancy against the assignment.** The brief's "about 192 planner runs,
4,011 turns, ~76.5 cost units" matches the `planner` role alone
(189 rows / 3,961 turns / 76.44 units, +2% on runs, −1.2% on turns). Its
"fusion: 6 runs, 217 turns, ~13 cost units" is the `consolidator` exactly; the
16 `planner-1..3` runs (318 turns, 3.28 units) are additional and were not
counted in the brief. The slice totals above are the rebuilt snapshot's numbers;
they are larger than the brief by exactly those 22 rows.

**Era composition.** Cost concentrates in the two oldest months, and the October
rows are mostly noise:

| month | rows | turns | cost units |
| --- | --- | --- | --- |
| 2026-07 | 21 | 993 | 40.24 |
| 2026-08 | 83 | 2,752 | 49.16 |
| 2026-09 | 2 | 175 | 0.10 |
| 2026-10 | 105 | 576 | 3.20 |

**Method.** (1) Slice and per-run/per-turn/per-call rollups with `sqlite3
-readonly` against `dataset/dataset.sqlite`, plus a new reusable query
`orientation-cost` added to `scripts/efficiency/analyze.ts` with tests; (2) the
existing helpers `roles`, `tools`, `repeated-calls`, `repeated-reads`,
`calls-per-turn`, `failed-chains`, `turn-gaps`, `cache-hit`, `context-growth`,
`events`, `handoffs`; (3) the raw snapshot for two things the dataset cannot
answer — the span-name inventory of `otel-tui/traces.sqlite` (what the trace
source can even see) and the one planner run whose tool inputs survive in
`main-store/telemetry/propose-orchestrator-model-selection.jsonl`; (4) the
product's own `agent-definitions/instructions/planning.md`,
`planning-fusion.md`, `fusion-consolidation.md` and
`src/workflow/steps/planning.ts` for *why* an agent behaved as it did.

Runs read closely (all with tool-call detail): `9d73b931-…` (planner,
`propose-orchestrator-model-selection`, the only argument-bearing planner run),
`b9904cce-…` and `e3ca1a7a-…` (consolidator), `ea6ae5e1-…`, `2d8fec8e-…`,
`275d6888-…`, `071bb4d5-…` (planner model comparison), plus the July
step-less rows `traces.otel-tui#introduce-random-score-tie-breaker#planner` and
`telemetry.main-store#check-workflow-bugs-frontier-model#planner`.

## Findings

| id | finding | quantified impact | confidence |
| --- | --- | --- | --- |
| F1 | Half of measurable planner spend precedes the first artifact | 8.22 of 16.19 units (50.7%), 1,004 of 1,944 turns (51.6%) over 51 runs | high on shape, medium that it is waste |
| F2 | Orientation is done through `bash`, not `read`/`grep` | 1,621 bash vs 908 read calls; 0 `grep` calls; ~46/55 shell calls in `9d73b931-…` | high |
| F3 | Single-call turns dominate | 1,598 of 2,153 turns (74.2%) make exactly one call | medium |
| F4 | Fusion cost = consolidator model, not the 3× planners | consolidator 12.98 units, 12.91 of it in 2 opus runs; planners 3.28 | high on arithmetic |
| F5 | 41–43× cost spread for identical planner work | 27-turn runs at 1.714 / 0.042 / 0.040 units | high |
| F6 | Premium consolidator did not converge | 80 turns / 8.837 units, 2 developer rejections, then 3 h 36 m idle | medium |
| F7 | 65% of slice cost is unattributable rows | 37 step-less rows, 60.25 units, 1,715 turns, 123 calls (all 123 failed) | high |
| F8 | 49% of planner "runs" are migration stubs | 93 of 189 rows: 1 turn, 0 calls, 0 cost, all started 2026-10-05T07:53–08:44 | high |
| F9 | Dead tool names still invoked | 12 planner calls to tools that do not exist in the repo (7/7, 4/4, 1/1 failing) | high |
| F10 | Revision rounds are cheap and rare | 5 rejections/4 workflows; 0–7 planner turns after each; ≤0.15 units | medium |
| F11 | Multi-hour stalls inside the planning phase | 19 gaps > 60 s; 59,223 s, 10,840 s, 4,699 s, 2,874 s | medium |

### F1 — Half of the measurable planner spend precedes the first artifact

**Evidence.** `analyze.ts orientation-cost --dataset <snapshot>`; role `planner`,
step `core.plan`: 152 rows, 51 with a `write`/`edit`, `avg_first_artifact_turn`
19.7, `turns_before` 1,004 of 2,246, `cost_before` 8.2161 of 16.1897 (0.507).
Restricted to the 51 artifact-writing runs the share is 1,004/1,944 = 51.6%.
610 of the 908 `core.plan` `read` calls sit in the pre-artifact half of those 51
runs. The single
argument-visible run `9d73b931-…` (56 turns, 92 calls, 0.0827 units) writes first
at turn 31; turns 0–30 hold 0.0380 units (46%).

**Impact and how it was estimated.** 8.22 units, 8.9% of the whole slice, is
attributable to the pre-artifact half of the 51 `core.plan` runs. `cost_before`
is the sum of `v_turns.cost` for turns whose `turn_index` is below the minimum
`write`/`edit` `turn_index` in the same run — real recorded cost, not an
allocation. It is an upper bound on *waste* and a lower bound on *cost*: some
orientation is unavoidable (see *Justified*), and the 8.22 excludes every
planner run whose calls were not recorded.

**Confidence.** High that the split exists and is about half; medium that half
of it is avoidable — the plan bodies are not in the snapshot, so I cannot tell
which exploration actually shaped the plan.

**Recommendation (prompt).** Give `core.plan` an explicit orientation budget:
state a target number of exploratory calls before the first artifact and tell
the planner to write a skeleton proposal/design early and extend it, instead of
reading first and writing once. Also state what may *not* be re-derived: the
change id, the artifact set from `openspec status`, and anything the run context
already carries.

**Verification.** Re-run `orientation-cost` on the next snapshot and compare
`cost_share_before` and `avg_first_artifact_turn` for `role='planner',
step_id='core.plan'`. Target: `turn_share_before` below 0.35 and
`avg_first_artifact_turn` below 12, with no rise in the rejected-plan rate.

### F2 — Orientation is done through `bash`, not through `read`/`grep`

**Evidence.** Slice tool mix: `bash` 1,718 calls, `read` 920, `write` 281,
`codemode` 60, `edit` 20, `developer_question` 32. Within `core.plan`: 1,621
bash vs 908 read. The `grep` tool is used 38 times in the snapshot and **never**
by a planner. In `9d73b931-…` the 55 bash calls were dominated by per-file
`ls`/`cat`/`grep`/`sed`/`find`/`wc`/`head` invocations; the same run used the
`read` tool once and `codemode` never.

**Impact.** Not separately costable — it is the mechanism behind F1 and F3: a
shell one-liner returns a whole file (or a whole subtree) where a bounded read or
a `grep` with a path filter would return the matching lines. Byte evidence is
too thin to weigh it (see *Data limits*), so I state it as a mechanism, not a
number.

**Confidence.** High on the call mix; medium on the counterfactual saving.

**Recommendation (tool definition + prompt).** Expose/mention `grep` and the
bounded `read` (offset/limit) in the planner's instruction as the default way to
inspect code, and reserve `bash` for build/`openspec` work. The sibling
instruction for workers already uses `grep`; planners should not be the
exception.

**Verification.** Track `grep`/`read` share of planner calls and mean
`result_bytes` per exploratory call per snapshot. Target: `grep` share > 0 and
bash below 40% of planner calls without a rise in `failed` calls.

### F3 — Single-call turns dominate the planner loop

**Evidence.** `calls-per-turn` restricted to the 59 call-visible `core.plan`
runs: 2,153 turns; 1,598 (74.2%) with exactly one call, 90 with none, 465
(21.6%) with two or more. Slice-wide, only 16 turns made 7+ calls; `codemode`
(60 calls, 56 of them in the Oct-2 `introdcude-pi-durable` planner run, 291,641
bytes of results) shows the runtime does support batched work.

**Impact.** Batching is a latency and cache-utilisation play more than a token
play: with a 98.3% cache-hit rate the marginal cost of an extra round-trip is
small, but each turn re-sends ~100 k tokens of context. Cutting 1,500
single-call turns in half would remove roughly 750 context re-sends per 59 runs.

**Confidence.** Medium. Some single-call turns are necessary — a `write` must
land before the next artifact is read back — and I cannot tag turns by tool from
the dataset without arguments.

**Recommendation (prompt).** Instruct planners to issue independent reads,
greps and `openspec status` queries together in one turn, and to avoid a turn
that carries a single speculative call.

**Verification.** `calls-per-turn` on the planner slice: target median calls per
turn ≥ 2 and `1` below 40% of turns.

### F4 — Fusion's cost is the consolidator's model, not the 3× planners

**Evidence.** 7 workflows contain fusion steps (`75b1b933-…`, `8cd37e9b-…`,
`9aaf048a-…`, `afaeb689-…`, `d50a4f46-…`, `e24d379f-…`, `ff61e755-…`, all
2026-08-25..28). `planner-1..3`: 16 rows, 318 turns, 3.28 units (0.205/run).
`consolidator`: 6 rows, 217 turns, 12.98 units — `b9904cce-…` (`afaeb689-…`,
`pi-copilot-opus`) 8.837, `e3ca1a7a-…` (`9aaf048a-…`, `pi-copilot-opus`) 4.072,
and four `pi-gpt-5.6-luna`/`pi-ox-alpha-free` runs totalling 0.071. In the 5
cheap fusion workflows the entire 3-planner + consolidator pipeline costs
0.002–0.068 units each, i.e. about the price of *one* single-planner run in the
same window (0.02–0.16).

**Impact.** Removing the consolidator's premium preset would have saved up to
12.9 units (13.9% of the slice) *if* a cheap model had consolidated equally
well — unproven here. Removing the redundancy (3 planners instead of 1) would
have saved only 3.28 units (3.5%): the parallel drafts are nearly free.

**Confidence.** High on the arithmetic (recorded cost); low on whether a cheap
consolidator would have been accepted.

**Recommendation (config).** Pin the consolidator to the cheap-medium pool
unless a measured signal justifies more, and make the classifier's plan-pool
choice visible per step (the snapshot has `routing.classified` only 16 times in
8 workflows, `model_selected` 42 times in 15 — too little to correlate).

**Verification.** Compare `consolidator` cost per accepted plan before/after,
using the `plan_quality_rejected` / `developer.action` counts as the outcome
proxy; target: cost/unit-per-accepted-plan down, rejection rate flat.

### F5 — The same planner work costs 41–43× more on a premium preset

**Evidence.** Three `core.plan` runs of identical shape:

| run | profile/model | turns | calls | cost |
| --- | --- | --- | --- | --- |
| `ea6ae5e1-…` | `pi-copilot-opus` | 27 | 41 | 1.714 |
| `2d8fec8e-…` | `pi-copilot-luna` | 27 | 46 | 0.040 |
| `275d6888-…` | `pi-gpt-5.6-luna` | 27 | 57 | 0.042 |

Mean cost per real planner run by profile: `pi-ox-alpha-free` 0.017,
`pi-gpt-5.6-luna` 0.042, `pi-sonnet-5` 0.054, `pi-copilot-luna` 0.061,
`pi-opencode-go-deepseek-flash` 0.061, `pi-planner` 0.745, step-less legacy
1.628, `pi-copilot-opus` 1.714, `pi-eon-sonnet` 3.115 (`071bb4d5-…`, 122 turns,
3.115 units).

**Impact.** The four premium runs in the slice (`ea6ae5e1-…`, `071bb4d5-…` and
the two opus consolidators of F4) hold 17.7 units — 19% of the slice — while
`ea6ae5e1-…` did call-for-call the same kind of work as runs costing ~40× less.

**Confidence.** High that cost differs; no outcome measure exists to say the
premium runs produced better plans.

**Recommendation (config).** Keep the plan pool cheap by default and route a
planner up only on a measured trigger (previous plan rejected, change touches
more than N files, prior verifier finding). The classifier already chooses from
pools — the snapshot shows the choice was made (`routing.classified`,
`model_selected`) but not why.

**Verification.** Cost per plan that reaches `plan_quality_passed` without a
`plan_quality_rejected`, split by pool, plus the rejection rate per pool.

### F6 — A premium consolidator that did not converge

**Evidence.** `afaeb689-…` (`introduce-okf-wiki`): three planners launched
11:20:47–11:21:01, settled 11:24–11:25; the consolidator handed off at 11:31:12,
11:41:56 and 11:51:56, with `developer.action` at 11:35:42 and 11:47:30 in
between (i.e. the consolidated plan came back twice); after the last handoff the
workflow did nothing until `operator.repair` at 15:28:02, when the worker
started. `b9904cce-…` carries 80 turns / 93 calls / 8.837 units, mostly `bash`
(70 of 93), first artifact at turn 19 of 80, peak context 188,092 tokens, total
wall clock 2,415 s (30.2 s/turn). `9aaf048a-…` consolidator `e3ca1a7a-…`: 35
turns, 4.072 units, one 2,874 s stall between turns 20 and 24.

**Impact.** 12.91 units across two runs, ~3.5 units per rejected consolidation
round, plus 3 h 36 m of planning-phase idle in `afaeb689-…`.

**Confidence.** Medium: the causal chain (premium model → verbose shell
exploration → unconvincing plan → rejection) is plausible from the shape and the
events, but the plan bodies are absent, so I cannot show *why* the developer
sent it back.

**Recommendation (tool definition + engine).** Give the consolidator the three
draft paths as explicit inputs and tell it to read exactly those and the files
the drafts name — it re-explores the repository instead (70 shell calls against
7 reads). Separately, emit a `plan.revision` event with the round number and the
trigger so revision rounds stop being invisible.

**Verification.** Consolidator shell:read ratio and cost per developer-accepted
consolidation, plus `plan.revision` count per workflow.

### F7 — Four fifths of the planner's cost is unattributable aggregate rows

**Evidence.** 37 of the 189 `planner` rows carry `step_id` NULL, no
model/profile, `status='unknown'` and synthetic run ids of the form
`<source>#<workflow>#planner` (e.g.
`traces.otel-tui#introduce-random-score-tie-breaker#planner`,
`telemetry.main-store#architecture-checkup-round-1#planner`). Together: 1,715
turns, 123 calls, **60.25 units = 79% of the planner role's cost and 65% of the
whole slice's cost**. All 123 recorded calls are failures, because those July
workflows emitted only `tool_error` spans and no `runtime.tool` spans. The
largest single row is
`traces.otel-tui#introduce-random-score-tie-breaker#planner` (90 turns, 7.778
units, 2 calls, both failing).

**Impact.** No output of this step can be attributed to a specific planner
attempt for that 65%: not orientation cost, not revision, not model choice. Any
"cost per plan" figure drawn from the slice is dominated by rows whose shape is
unknowable.

**Confidence.** High — it is a property of the data, verified against the span
inventory (`traces.sqlite` has 11,367 `runtime.tool` spans overall, but none for
those July workflows; only 511 `tool_error`), not an inference.

**Recommendation (engine/data).** Not a product behaviour fix but a measurement
one: keep emitting `runtime.tool` spans (they exist from late August on), and
treat a role row without `step_id` as an aggregate rather than a run — give it a
distinct key so per-run statistics cannot silently absorb it.

**Verification.** `orientation-cost` restricted to `step_id IS NOT NULL` should
cover the same cost share as the total; today it covers 16.19 of 76.44 units.

### F8 — Half of the planner "runs" are migration stubs

**Evidence.** 93 of the 189 `planner` rows are `profile='legacy-pi-durable'`
with exactly 1 turn, 0 calls and 0 cost, all `started_at` between
2026-10-05T07:53:10 and 08:44:39, in the same window as 416 `legacy.migrated`
events. Their workflows are UUIDs with no `definition_id` and no other runs. Ten
further `legacy-pi-durable` rows in the same window are real (27–36 turns, 25–35
bash calls, 0–1 writes) but carry no cost at all.

**Impact.** The run count of the slice is inflated by 49% (189 → 96 real
planner rows). Any per-run average over the slice — including the brief's own
"192 planner runs" — is about 2× too low. Symmetrically, the 10 real
`legacy-pi-durable` runs (≈3,000 turns' worth of work) contribute 0 units, so
total slice cost is understated.

**Confidence.** High (timestamp clustering plus the migration event count).

**Recommendation (engine/data).** Mark or exclude migration-created runs; store
cost when it is known rather than 0 for a whole source.

**Verification.** Count rows with `turns <= 1 AND cost = 0` per snapshot; it
should fall to zero outside a deliberate migration record.

### F9 — Dead tool names were still being invoked

**Evidence.** Planner calls to tools that appear nowhere in the repository
today: `jira_get_issue` 7 calls / 7 failures (workflows `add-comment-count`,
`ngNb-cases-cannot-be-registered`, `sorting-and-filtering`,
`adjust-ee-co-location-structure`, `add-exclusion-reason-to-request-response`,
`remove-min-capacity-kw-from-admin-fe`, `cleanup-documents-without-request-link`),
`ask_user_question` 4/4, `gh_grep_search` 1/1. Overall failure rates: planner
`bash` 127/1,718 (7.4%), `read` 15/920 (1.6%), 157 failed of 2,248 calls with a
recorded outcome (7.0%).

**Impact.** 12 calls, all in July/August workflows — small in absolute terms
(0.3% of slice calls), but each was a guaranteed-failing turn.

**Confidence.** High.

**Recommendation (tool definition).** Keep the planner toolset to tools that
exist and can succeed; a tool that always fails costs a turn and misleads the
model about its options.

**Verification.** Assert no call in a snapshot targets a tool name absent from
the repository's tool registry.

### F10 — Revision rounds are cheap and rare in this slice

**Evidence.** `plan_quality_rejected` 5 across 4 workflows and
`plan_quality_issue` 2 across 2, all in July (4 rejected) and August (1) — none
after. Planner turns after the last rejection: 5 (`add-scoring-to-csv-output-…`,
cost 0.0), 7 (`change-plausicheck-limits`, 0.1501), 5 (`add-local-service-otel`,
0.0), 0 (`add-comment-count`). Developer review comments: 18 comments in 5
workflows, all July/August. Only 1 planner run in the whole slice is attempt 2
(`c38f863f-…`, `confidence-gating-removal`, 0.096 units).

**Impact.** Plan revision is ≈0.15 units per revised plan — under 0.2% of the
slice. There is no revision hotspot to fix.

**Confidence.** Medium: the newer plan-review flow records
`developer_review_comment` for plan artifacts, but no such event exists after
August in this snapshot, so the modern revision path is effectively unobserved.

**Recommendation (engine).** Do not optimise revision; instead emit a revision
event that ties a re-plan to its trigger, so the next snapshot can measure it.

**Verification.** Rejection rate and turns-after-rejection once the event
exists.

### F11 — Multi-hour stalls inside the planning phase

**Evidence.** `turn-gaps`, planner slice: 19 gaps over 60 s. Largest: 59,223 s
(`traces.otel-tui#improve-logging#planner`, 856.8 s/turn across 70 turns),
10,840 s (`telemetry.main-store#check-workflow-bugs-frontier-model#planner`),
4,699 s (`fix-frontend-pathing`), 2,874 s (`e3ca1a7a-…`, between turns 20 and
24), 2,648 s, 1,505 s, 1,462 s. Developer-question waits are much shorter:
`developer.question.created` 44 / `answered` 37 / `prompt_wait_timeout` 7, with
the longest wait 1,311 s (`22d8a7a3-…`, 2026-08-31) and most under 3 min.

**Impact.** Wall-clock, not tokens. The 16.5 h `improve-logging` span almost
certainly contains an overnight pause before a resumed run, so I do **not** count
it as compute waste; the 2,874 s mid-run stall on a consolidator that then wrote
more artifacts is the one that looks like genuine engine/pause overhead.

**Confidence.** Medium; the trace source timestamps a turn at its LLM call, so a
gap can be a queue, a developer wait, or a machine asleep.

**Recommendation (engine).** Record a reason on long gaps (waiting for
developer, paused, retry backoff) so this stops being ambiguous.

**Verification.** Gap count and their reasons per snapshot.

## Justified

- **`openspec` CLI traffic.** `9d73b931-…` makes 9 `openspec` bash calls, about
  16% of its 55 shell calls. `planning.md`/`fusion-consolidation.md` mandate
  `openspec new` + `status` + one `instructions` per artifact + a re-check after
  each + `validate --strict`, i.e. roughly `2N+4` invocations for N artifacts
  (typically 4–6). Nine observed calls is *less* than the prompt prescribes, and
  no invocation is repeated. Engine-side `openspec.validate` effects: 1 in
  `main-store` telemetry and 2 spans in the trace store, both attempt 1 — no
  validation loop exists in this data.
- **Reading before writing.** A planner must choose a change id and author
  artifacts it has not seen; the first `openspec status` call is itself an
  orientation step. F1 measures the *size* of the orientation half, not the
  proposition that orientation should be zero.
- **High turn counts in the biggest July rows.** `introduce-random-score-tie-
  breaker` (90 planner turns) is 90 genuine LLM requests (`model_usage` spans),
  not a duplicated count — `provider_response` spans do not create turns. Its
  per-turn cost is 0.03–0.09 units at ~100% cache hit, and no repeated identical
  call appears. Expensive, not obviously looped.
- **Compaction absence.** No planner-slice run compacted: all 7 compaction
  events in the snapshot belong to `worker` runs in two July workflows. Planner
  peak context reaches 110–188 k tokens, so compaction is aligned with workers,
  not planners, in this data — not a planner defect.
- **Cache behaviour.** 96,288,306 cache-read tokens against 1,698,984 input
  tokens (98.3% hit) across the 37 usage-bearing planner/consolidator runs — the
  prompt-prefix caching works; the large `cache_read` figures in the July rows
  are the *result* of long runs, not a defect.
- **`codemode` under-use, not over-use.** 60 calls in the slice, 56 of them in
  one October planner run returning 291,641 bytes. The one place where the
  agent batched its exploration is the newest run in the slice — a data point
  *for* F3's recommendation, not against it.
- **Large single reads.** The largest recorded planner read result is 21,946
  bytes (`confidence-gating-removal`), a normal source file. Only two workflows
  have any read size at all, so "reading whole large files" cannot be
  substantiated at slice level.

## Data limits

1. **No transcripts at all.** The rebuilt dataset contains **zero** `harness.*`
   turns; all five harness SQLite stores parsed 0 records. The brief's "about 56
   transcript turns" for planners is not present, so nothing here rests on
   prompt/response text. This also means `thinking_tokens` and `stop_reason` are
   NULL for every planner turn.
2. **Arguments survive for exactly one planner run** of 211
   (`9d73b931-…`, 92 calls, from
   `main-store/telemetry/propose-orchestrator-model-selection.jsonl`). Hence
   `repeated-calls` and `repeated-reads` return **0 groups for the whole slice**.
   That is the absence of *evidence* of repetition, not evidence of its absence:
   I can neither confirm nor refute re-reading the same specs across rounds.
3. **60.25 units (79% of planner-role, 65% of slice cost) is in 37 step-less
   aggregate rows** (F7) with 123
   recorded calls, all failures. Their call shape, model and step are unknown.
4. **93 planner rows are migration stubs** (F8), and 10 real `legacy-pi-durable`
   rows carry `cost = 0`, so the slice total (92.70) is a lower bound.
5. **Byte coverage is thin.** For `core.plan`: `result_bytes` on 145/1,621 bash,
   29/908 read, 31/281 write, 56/60 `codemode`; `args_bytes` on 217/1,621 bash.
   `fusion.plan` and `fusion.consolidate` calls carry no sizes at all. The
   traces source stores `pi.tool.result_bytes`/`pi.tool.argument_bytes` on
   `runtime.tool` spans, but the extractor only picks them up when the
   respective events carry them, so most survive as NULL.
6. **Plan bodies are absent.** No proposal/design/tasks/spec file content is in
   the snapshot. Plan size and plan quality are approximated by the planner's
   output tokens (mean 18,810 across the 44 workflows that both planned and
   produced worker edits) and by the gates; "plan size vs
   change size" therefore cannot be measured properly. A crude cut — workflows
   with ≤3 worker `write`/`edit` calls average 33.5 planner turns and 0.319
   units — is confounded: that bucket is mostly July workflows whose call data
   was never recorded, so those `edits` are 0 because nothing was recorded, not
   because nothing was changed.
7. **Durable stores cover 3 workflows.** `main-store/herdr.db` and its Oct-14
   backup hold only recent instances (11 and 21 outbox rows), so engine-side
   effect attempts and empty settles cannot be counted for the historical
   planner runs; the 2,205 `effect.result` events in the dataset carry no effect
   *kind*, so effect-level retry analysis is limited to the trace store's 1,030
   `effect.result` spans.
8. **Routing classification is nearly invisible**: `routing.classified` 16 in 8
   workflows, `runtime.model_selected`/`model_selected` 42 in 15. The plan-pool
   choice cannot be correlated with revisions or questions at any usable
   significance.

## Recommendations ranked by expected saving per effort

1. **Config — stop paying premium prices for plan work by default.** The 4
   premium planner/consolidator runs in the slice hold 17.7 units (19%); two
   premium consolidations alone are 12.9 units (13.9%). Expected saving: up to
   ~13 units per 92.7-unit slice at near-zero effort. Verify with cost per
   accepted plan split by pool (F4, F5).
2. **Prompt — give `core.plan` an orientation budget and write artifacts
   early.** Expected saving: 20–40% of the 8.22-unit orientation half, i.e.
   1.6–3.3 units (2–4% of the slice) plus latency. Verify with
   `orientation-cost` targets (F1).
3. **Tool definition + prompt — make `grep`/bounded `read`/`codemode` the
   default inspection path for planners, not shell pipelines.** Feeds both F1
   and F3; measured by the tool mix per snapshot (F2).
4. **Prompt — batch independent calls per turn.** Removes context re-sends
   rather than tokens; measured by `calls-per-turn` median (F3).
5. **Engine — emit `plan.revision` and a reason on long gaps.** Cheap, and it
   makes F6, F10 and F11 measurable next round instead of inferred.
6. **Engine/data — fix measurement, not behaviour.** Keep `runtime.tool` spans
   (F7), do not create 1-turn runs for migrations (F8), record `cost` when known,
   and carry `pi.tool.argument_bytes`/`result_bytes` through extraction so byte
   questions can be answered.

## Open questions

- **Was the premium consolidator worth it?** Two opus consolidations cost 12.91
  units; one was rejected twice and produced a 3.5-hour idle workflow, the other
  is the 4th most expensive run in the slice. There is no accepted-plan count or
  plan-quality score to balance that against. *Needed:* plan artifact bodies,
  per-plan developer review outcomes, and a `plan.revision` event.
- **Is the orientation half waste or necessary?** *Needed:* the plan text plus
  the call arguments of the artifacts it produced (does the final plan cite the
  files that were read first?).
- **Does a model downgrade raise the rejection rate?** The pool choice exists
  (`routing.classified`, `model_selected`) but outcomes per plan do not. *Needed:*
  plan-level acceptance linked to the planner's profile.
- **Does fusion produce better plans than one planner?** With 7 fusion workflows,
  4 of which reached implementation, and no plan scoring, the benefit side is
  unmeasured; only the cost side (F4) is. *Needed:* review outcomes per fusion
  workflow against a matched single-planner cohort.
- **Was anything re-read?** Not answerable from this snapshot: one planner run
  has arguments and it contains no exact duplicate call. *Needed:* extracted tool
  arguments for planner calls.
