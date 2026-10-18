# Efficiency review step 3 — prioritized backlog

Ready to be started item by item. Every item is sized to become **one OpenSpec
change** or **one solo fix workflow**, and every item carries the query that
proves it afterwards, the baseline from the pinned dataset, and the target.

**Reference build:** pinned dataset `2026-10-16T12:35:27Z`, preferred rows —
**391.0161 cost units, 33,137 turns, 25,024 calls, 1,238 runs**. Savings are
ranges in those units unless a surface lies outside the corpus (the orchestrator
conversation is measured in computed USD and is *not* part of the 391.0161).
Effort is S/M/L; "certainty" is how sure the *waste* is real, not how large the
saving is.

Read [`03-synthesis.md`](./03-synthesis.md) for the verification table behind
every number quoted here.

## Ranked list

| rank | item | kind | effort | certainty | saving (low/likely/high, units) |
| --- | --- | --- | --- | --- | --- |
| — | 0. Analysis-tooling repair + `kpi-baseline` (shipped in this step) | telemetry | S | — | 0 (unblocks everything) |
| 1 | 2. Keep tool inputs, result sizes, durations and failure kinds | telemetry | S | high | 0 (unblocks 6, 7, 12, 15, 16, 21) |
| 2 | 4. Default `bash` timeout with an elapsed-time nudge | config + engine | S | high | 1 / 3 / 6 + 2.4 min/incident |
| 3 | 5. `workflow_status` compact projection by default | tool definition | S | high | $3.0 / $5.3 / $8.0 (of that conversation) |
| 4 | 3. Fail fast on a run with no successful call | engine | S | high | 0.5 / 2 / 5 + reliability |
| 5 | 6. Compact JSON and compact rows for the list tools | tool definition | S | high | $2.0 / $3.5 / $5.0 |
| 6 | 7. Cost-aware compaction ceiling | config/default | S | high | 4 / 12 / 25 |
| 7 | 13. `env_list` answers the default-target question | tool definition | S | high | 0.2 / 0.5 / 1.5 + 15 min/run |
| 8 | 12. Self-correcting `edit`/`read` failures | tool definition | S | high | 1 / 3 / 6 |
| 9 | 9. One `verification_round` event per round | engine | S | high | 0 (unblocks 14 and the yield answer) |
| 10 | 8. `triage.plan.selected` and `gate.decision` events | engine | S | high | 0 (unblocks the round/role questions) |
| 11 | 10. Record `operator.repair`'s cause and effect | engine | S | high | 0 (makes 31.9 % of cost analysable) |
| 12 | 11. `workflow.waiting` event (agent time vs human wait) | engine | S | high | 0 (separates 59 min of waits from agent time) |
| 13 | 15. Orientation budget + the plan's file list in the assignment | prompt + task shape | M | medium | 5 / 8 / 12 |
| 14 | 16. Name `read`/`grep`/`codemode` where the agent reads them | prompt + tool definition | M | medium | 1 / 4 / 9 (measured with 15) |
| 15 | 14. Role-scoped re-verification + forwarded findings | engine | M | medium | 2 / 4 / 7 |
| 16 | 19. Preflight push credentials; block once | engine | S | high | reliability (0.2 + a 2 h stall) |
| 17 | 18. Bound the archive repair loop | prompt + engine | S | high | 0.3 / 1 / 2 |
| 18 | 26. Deduplicate and digest the monitor notes | engine | S | high | $0.8 / $3 / $6 (of that conversation) |
| 19 | 21. Turn/context ceiling with a convergence checkpoint | engine | M | high | 8 / 20 / 40 |
| 20 | 20. Run window = session window | engine + telemetry | M | high | 0 (156 runs currently mis-attributed) |
| 21 | 23. Task reference, change existence, keyed status polls | tool definition | M | medium | $2 / $6 / $12 (of that conversation) |
| 22 | 17. Archive happy path back into a delivery effect | engine | M | medium | 1.0 / 1.6 / 1.85 |
| 23 | 22. Fix the harness reader; alarm on a source that parsed nothing | telemetry | L | high | 0 (restores 2,263 turns / 2,803 calls) |
| 24 | 25. Model tiering for mechanical steps (measure, then pin) | config | M | medium | 20 / 40 / 70, quality-gated |
| 25 | 24. Per-workflow telemetry that survives the whole run | telemetry | L | high | 0 (21 of 86 modern worker runs are invisible) |

Ordering rule: 1 → 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 (all independent after
item 1); 9 and 10 unlock 14 and 25; 1 unlocks 15, 16 and 21; 23 should precede
any "did it work" review of 13–21.

---

## 0. Analysis-tooling repair and the KPI board — **shipped in this step**

*Committed with this review; listed so the tree's state is unambiguous.*

**Problem.** `scripts/efficiency/lib/queries.ts` had lost three object boundaries
in a merge: `source-gaps`, `delivery-timeline` and `run-window-drift` were
spliced into `source-recording`, so 30 definitions produced 27 reachable queries
and the three whose numbers `02e`/`02f`/`02g` rest on could not be run by name.
`test/efficiency/efficiency-queries.test.ts` had four spliced test bodies, so
`bun run type-check` **failed on main** (9 errors) and no assertion added by
`02b`/`02c`/`02d`/`02h` was exercised.

**Change.** Restore the three query boundaries; split the spliced tests; add
`kpi-baseline` (append-only) with a focused test.

**Verify.** `bun run type-check` (clean), `bun test test/efficiency` (**57 pass,
0 fail**), and each restored query runs against the pinned dataset (`source-gaps`
→ 9 rows, `run-window-drift` → 156 runs, `delivery-timeline` → the wiki-approval
gaps).

## 1. Keep the tool inputs, result sizes, durations and failure kinds

**Problem (VERIFIED).** 2 of 9,226 verifier calls carry an argument digest; 81 %
of verifier calls have no result size; 82 % of bash calls have no duration; the
only failure vocabulary is `tool_error`/`error`, so a missing file, a failed
edit and a broken tool host are indistinguishable. Every byte-level and
retry question in the eight dives ended in "cannot be measured".

**Change.** For every tool call record: run id, role, round index, turn index,
tool name, `args_hash` + a bounded secret-free digest (path for `read`/`grep`,
command head for `bash`), `result_bytes`/`result_lines`/`result_truncated`,
`ok` + a machine-readable failure kind (`not-found`, `no-match`, `denied`,
`host-error`, `timeout`, `aborted`), and `duration_ms`. No payload text.

**Saving.** None directly; it is the precondition for items 6, 7, 12, 15, 16,
21 and for any retry measurement.

**Effort/risk.** S. Risk: telemetry volume (bounded fields only). Touches
`src/workflow/adapters.ts`, `src/agent-host/`, the telemetry emit path, and the
dataset extractor (`scripts/efficiency/lib/telemetry.ts`) plus a redaction test.

**Verify.** `analyze.ts source-recording` must show `unknown = 0` for the new
generation; a follow-up query reports "failed calls per 100 calls by kind" and
"exact repeats per run". Baseline: 2/9,226 calls with args — target 100 %.

**Workflow.** Solo fix workflow, cheap-medium preset (`pi-opencode-go-deepseek-flash`).

## 2. Default `bash` timeout with an elapsed-time nudge

**Problem (VERIFIED at source).** One recursive `grep` ran **1,202 s (41 % of a
run)** with no `timeout` argument and returned 50 bytes; a repository-wide `find`
from `/` ran 227 s the run before. Both needed a human abort and produced the
only two blocked handoffs in those runs. The tool has a `timeout` parameter and
no default.

**Change.** Give `bash` a default wall-clock bound (120 s, overridable), state
the bound in the result when it fires, and surface "this call has run N s" to the
model at ~60 s. Add one line to the global-search guard's message telling the
agent to scope the path.

**Saving.** Modelled 1 / 3 / 6 units, plus the two developer aborts (≈24 min) and
one blocked handoff per incident.

**Effort/risk.** S. Risk: a legitimate first `docker build`/`mvn test` exceeds
120 s — the structured `env_build`/`env_test` path exists for exactly those, and
`timeout` stays the override.

**Verify.** Count calls with duration > 60 s and aborted calls per run before and
after. Baselines: 1,202 s and 227 s aborts; 3 calls hit exactly 300.1 s and
failed in the worker slice.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 3. Fail fast on a run with no successful tool call

**Problem (VERIFIED).** 57 verifier runs have every recorded call failed —
2,492 turns and 15.0454 units — but **all 57 are Jul/Aug, where the recording
kept failures only** (Jul/Aug calls are 100 % failed: 402/402, 275/275, 25/25,
236/236), and **0 such runs exist after 2026-09-01**. The real defect is that
nothing cuts a run short when its tool surface is dead: `sanety-check-workflow-steps`
made 16/16 failed bash calls over 194 turns, `add-developer-review-ui` 16/16 over
190, and the same "no successful call" state is invisible today because §1 is
missing.

**Change.** After N consecutive failed calls with zero successes, retry the tool
host once, then hand off `blocked` naming the tool and the failure kind.

**Saving.** Modelled 0.5 / 2 / 5 units and a reliability gain; the measured
target is the counter, not the money.

**Effort/risk.** S. Risk: a legitimate exploration of a nonexistent path could
trip it — require *zero* successes and ≥3 consecutive failures.

**Verify.** `analyze.ts source-recording` for the era split, then "runs with zero
successful calls per 1,000 verifier runs". Baseline: 201.3 per 1,000 across all
eras (artefact-inflated), **0** post-2026-09-01 for verifiers — target <20 and a
bounded turn count.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 4. `workflow_status` returns a compact projection by default

**Problem (VERIFIED).** 86 calls / **472,527 B** in one conversation. `task` is
≈47 % of the bytes; `orchestratorQuestions` is a byte-identical copy of
`pendingQuestions` in 30 of 77 parsed calls (12,278 B of literal duplication);
`runs` (53,822 B) and `gateDecisions` (20,243 B) are history re-sent every poll.
The 60,000-char cap never bound (largest result 53,524 B) — the waste is field
selection.

**Change.** Default projection: `workflowId, target, status, step, attention,
revision, changedSinceLastPoll (bool), pendingQuestions` — and emit
`orchestratorQuestions` and `task` only with an explicit `detail: "full"` (or
`includeTask: true`). Drop `orchestratorQuestions` entirely once
`pendingQuestions` carries the routed questions; cap `runs`/`gateDecisions`
behind a flag. Answer "nothing changed" in a few bytes when `revision` is
unchanged (this is item 21's cheap half, which is why it ships here).

**Saving.** Modelled $3.0 / $5.3 / $8.0 of that conversation ($5.30 is the
report's own task+duplicate figure).

**Effort/risk.** S. Risk: an orchestrator that genuinely needs the task text must
ask — document the flag in the tool description, and log when it is used.

**Verify.** Result bytes per tool in `tool_calls` / the harness; target median
`workflow_status` result **< 4 kB** (baseline: 472,527 B over 86 calls ≈ 5.5 kB
mean, 51,245 B max).

**Workflow.** Solo fix workflow, cheap-medium preset; add a unit test for the
projection and the `revision` short-circuit.

## 5. Compact JSON and compact rows for every orchestrator list tool

**Problem (VERIFIED).** `list_workflows` 21 calls / **276,823 B**, of which
`task` is 58 % and the JSON is pretty-printed with a 4-space indent;
`list_agent_config` is 40 % indentation (20,607 B raw → 12,406 B compact);
`list_branches` was called three times with identical 12.6 kB results;
`start_workflow` writes 163,350 B of arguments, 93 % of it `task` — prose the
developer already typed, paid again as output tokens and then re-read on every
later turn.

**Change.** Compact JSON everywhere; `list_workflows` default row
`{id, target, status, step, attention, branch}` with the task text opt-in;
`start_workflow` accepts a task *reference* (an OpenSpec change path, or "the
previous developer message") as an alternative to the text; report the dirty
paths on a "working tree must be clean" refusal.

**Saving.** Modelled $2.0 / $3.5 / $5.0 of that conversation ($2.82 task +
$0.68 indentation measured).

**Effort/risk.** S. Risk: a compact row can hide the field an orchestrator picks
an id from — the compact row must still carry the identifier both tools accept
(item 21).

**Verify.** Result bytes per tool; target median `list_workflows` **≈2 kB**
(baseline 13.2 kB mean).

**Workflow.** Solo fix workflow, cheap-medium preset.

## 6. A cost-aware compaction ceiling

**Problem (VERIFIED).** `COMPACTION_DEFAULTS` resolve to `max(32,000, 30 % of
the window)` → a **700,000-token** blocking threshold on the 1 M windows every
preset actually uses, so automatic compaction is unreachable: 7
`compaction_requested` events in 2 workflows, **0 modern**. Meanwhile one worker
run peaked at **911,257 tokens**, the orchestrator at 333,278, and 213 of its 570
turns sat above 150 k. Within a long run the second half costs 1.87–2.9× the
first.

**Change.** Separate the two purposes: keep the window-relative *overflow* reserve
as the last-resort blocking threshold, and add a **cost ceiling** for long-lived
sessions (default ~150 k tokens, configurable) that triggers compaction
proactively; offer `keepRecentTokens` as the percentage field it already is; and
record peak context per run so the ceiling's effect is measurable.

**Saving.** Measured for the orchestrator: $8.30 of $48.13 at a 150 k cap (213
turns above the line). Modelled corpus-wide 4 / 12 / 25 units.

**Effort/risk.** S. Risk: compacting a 700 k context costs a re-read; the
default must stay above the point where a summary's own cost exceeds the
re-writes it prevents — measure after the first week rather than guess (open
question in `02b`).

**Verify.** `cache-expiry` and `context-growth` on the next long session, and
`compaction_*` events per workflow; target: automatic compactions > 0, peak
context < 200 k, per-decile cost curve flatter than 3.3×.

**Workflow.** Solo fix workflow, cheap-medium preset; touches
`src/workflow/compaction.ts` and the Settings read/write.

**Implemented.** The policy now carries two independent triggers.
`reserveTokens` is unchanged and stays the last-resort overflow guard
(`max(32000, 30 % of the window)`, so 700,000 tokens on the 1 M windows the
presets run). `ceilingTokens` is the new absolute cost ceiling, default
**150,000** (the line the measurements in `02h` were taken at), configurable in
Settings → Compaction next to the other fields, `0` to turn it off;
`enabled: false` turns it off too. It applies only when it is *below* the
overflow threshold — on a small window the overflow guard is the tighter one and
a higher ceiling is ignored once with a `runtime.compaction_ceiling` warning.
A ceiling compaction is admitted at the measured end of a turn (the controller
uses the same prompt counters `runtime.usage` carries) and placed by pi-durable
at the next turn boundary, so it never interrupts a tool call. The floor is 20
turns or 40,000 tokens of new context since the last ceiling compaction (the
reduced context is measured after the summary, so the floor counts real growth),
the kept-verbatim tail is resolved to at most half an active ceiling, and the loop
guard stops ceiling compaction for the session after three compactions inside ten
turns, recording a `loop-guard` warning. The ceiling passes no instructions to the
summarizer, so it keeps the head context (assignment, plan/finding references)
exactly as the overflow path does.

The default of 150,000 is a starting point, not a measured optimum: a summary
costs roughly one pass over the range it replaces, so compacting far below
~100 k trades cheaper tails for more summaries than it saves. That is why the
per-run record matters:

- every compaction envelope carries `kind` (`auto-ceiling`, `auto-overflow`,
  `manual`), and `runtime.settled` carries `peakContextTokens` plus the per-kind
  counts of the run;
- `bun run scripts/efficiency/analyze.ts compactions --dataset <dir>` returns,
  per run, the count of each kind, `peak_context_tokens` (input + cache read +
  cache write, i.e. the context the ceiling is compared against) and the run's
  cost. Next week's snapshot answers "automatic compactions > 0, peak context <
  200 k, cost curve flatter" from that one query; if the ceiling is too high or
  too low, the `ceilingTokens` field is the thing to move (and the `ignored` /
  `suspended` envelopes say when a window or a loop made it moot).

## 7. `env_list` answers the default-target question and carries infra reachability

**Problem (VERIFIED at source).** `env_list` reports `defaultAmbiguous: true`
and says nothing about what resolves it, so one env-setup run spent **853 s
(29 % of the run)** — 39 turns, 60 calls, including eight `grep -a -o` calls
against a 92 MB compiled binary (613 s) — rediscovering a rule the engine
already computes (`defaultTargetOf`, `supersededIds`). It also returns
**31–43 KB per call** to every run told to call it first, and its
infrastructure entries carry only `{ident, type}` while `db_query` refuses with
"declares no query connection".

**Change.** Add a per-app `defaults` block naming the effective default target
per action, the reason (`default` / `only-target` / `ambiguous`), and which live
ids a draft supersedes; add a one-line hint on an ambiguous group; add
`queryConnection: bool` (and endpoints) to each infra entry; compress the default
result with an app filter or an opt-in `detail`.

**Saving.** Modelled 0.2 / 0.5 / 1.5 units plus ~15 min of an env-setup run;
removes ~35 KB of context per affected run.

**Effort/risk.** S. Risk: none material — the values already exist; the wording
must match the brief's ("supersedes").

**Verify.** Count calls per env-setup run whose arguments touch the product repo
or `dist/agentic-coding` (73 in run 2, 50 in run 1) and the window from the first
`env_list` to the first `env_build`; target single digits. Result bytes for
`env_list`: 31–43 KB → target < 8 KB default.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 8. Self-correcting `edit` and `read` failures

**Problem (VERIFIED).** `edit` fails **189/1,558 = 12.1 %** post-2026-08-31
(292/1,661 all eras, 17.6 %) with "oldText not found / not unique / edits
overlap", each failure costing a full turn plus a re-read to re-derive the text.
Nine of the 22 errors in one run were the *same* mistake: a repo-root-relative
path while the package lives one level down — the tool answers bare ENOENT.

**Change.** On an `edit` failure return the nearest matching text with line
numbers; on ENOENT for `read`/`grep`/`edit` suggest the nearest existing path
(and say when a path is a directory); both suggestions derived locally, never
from the model.

**Saving.** Modelled 1 / 3 / 6 units.

**Effort/risk.** S. Risk: a nearest-match suggestion can mislead — present it as
"did you mean", never as a silent substitution.

**Verify.** `edit` failure rate per era from `source-recording` (baseline 12.1 %
post-August, 17.6 % raw), wrong-root ENOENT count per run; target `edit` < 8 %
and wrong-root errors → 0.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 9. One `verification_round` event per round

**Problem (VERIFIED).** 121 rounds (100 workflows) reconstructed from timing
because the engine's `attempt` field exists on only 44 verifier runs; 262 finding
events (156 + 106) with `detail IS NULL` on all of them, window
**2026-07-27…2026-08-14**; 72 of the 121 rounds carry no yield signal at all, and
current rounds are wholly unmeasurable.

**Change.** Emit one `verification_round` per round: workflow, run ids, round
index, selected role set, the file→role map, changed files, findings by severity,
accepted count, previous round's finding ids, turns, tokens, cost, peak context.

**Saving.** None directly; it is the only way to settle items 14 and 25 and the
"51 % of rounds find nothing" question.

**Effort/risk.** S. Risk: an event per round is cheap; keep the payload bounded
(counts + digests, not file bodies).

**Verify.** 100 % of rounds carry the row, then recompute rounds ≥2 as a share of
round 1 from that event alone. Baseline: `verifier-rounds` 7.198 of 48.087 units
(15 %).

**Workflow.** Solo fix workflow, cheap-medium preset.

## 10. `triage.plan.selected` and `gate.decision` events

**Problem (VERIFIED).** 1,584 `triage_*` events and `verifier_dispatched`/
`verification_started` all end 2026-08-14T08:37:20Z; today the selection is
invisible. Of ~16 recorded gate evaluations only **4 `gate.skip`** exist (all
`core.wiki-gate`, 2026-09-28/29) and a gate that decides `run` emits nothing, so
neither the numerator nor the denominator is recoverable.

**Change.** One `triage.plan.selected` per round (selected roles, per-role file
list or count+digest, changed-file count, and which path produced it:
classifier / default / empty bypass) and one `gate.decision` per evaluation
(decision, latency, policy source `auto` or `always`).

**Saving.** None directly. It converts "gates look like no-ops" and "roles
widened to 5.1" from inference into measurement — and 87 % of the rounds I can
measure already run ≤4 roles, so the feared widening may not exist.

**Effort/risk.** S. Risk: none.

**Verify.** 100 % of rounds and gate evaluations carry a row; recompute roles per
round and skips per gate stage. Baselines: roles 1:13, 2:23, 3:35, 4:34, 5:7,
6:4, 7:4, 8:1; gate skips 4.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 11. Record `operator.repair`'s cause and effect

**Problem (VERIFIED).** 42 repairs across 23 workflows; those 23 workflows carry
**124.64 of 391.02 units (31.9 %)**, mean 5.42 units/workflow against 1.16 for
the others. The event's `reason` length is 0 in the sampled rows, so *why* is
unknowable and the cohort stays a correlation.

**Change.** Carry the repair reason (the command already has it), the expired
effect ids, the retired run ids, and a workflow-level repair count; surface it in
the workflow view next to blocked handoffs.

**Saving.** None directly; it is what turns 31.9 % of the corpus into an
actionable cohort.

**Effort/risk.** S. Risk: the reason string is free text — bound and redact it
the way `detail` already is.

**Verify.** 100 % of repairs carry a non-empty reason and an expired-effect
count; then measure re-run cost of a repaired step. Baseline: 42 / 23.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 12. `workflow.waiting` — separate agent time from developer wait

**Problem (VERIFIED).** 22 measurable question waits total 3,562 s (mean
162 s, median 112 s per `02d`; `02g` measures an 800 s mean across the snapshot,
worst 76.6 min); 18 blocked
handoffs (1 Sep, 17 Oct); between-run gaps are 127 of 1–10 min, 48 of 10–60 min
and 15 over an hour — and only the last category is *today* attributable to a
human rather than to the old engine's `prompt_wait_timeout` (7 events, July).

**Change.** Emit `workflow.waiting` on entering any developer-blocking state
(question, blocked handoff, approval) with the reason, and its end; report agent
time and human wait as two numbers per workflow.

**Saving.** None directly. It is the only way "waiting for the developer is the
biggest block of wall time" becomes a number instead of an inference, and it
stops human latency from being booked as agent cost (see *do not change* 4–5 in
the synthesis).

**Effort/risk.** S. Risk: a missing end event for a killed run — treat an open
wait at run close as ended at close.

**Verify.** Every developer-blocking state has a matched pair; report the split
per workflow. Baseline: 18 blocked handoffs, 44 questions, 22 waits = 3,562 s.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 13. Orientation budget, and the plan's file list in the assignment

**Problem (VERIFIED).** `core.plan` spends **8.2161 of 16.1897 units (50.7 %)**
before its first artifact and writes first at turn 19.7; wiki spends **66 %**
(1.2833 of 1.9434) with its first write at turn 53.3, seven of twelve runs
spending ≥95 % of their calls before writing; the five fully-evidenced worker
runs spend **44 % of calls and 67 % of result bytes** before the first edit
(360/820 calls, 1,258/1,882 KB), and in one run 33 of 39 read/grep targets were
not among the files it edited.

**Change.** Three prompt/task-shape edits in one change: (a) planner and wiki
briefs state an exploratory budget and "write a skeleton early, extend it";
(b) the implementation assignment carries the plan's file list (and the task text
already does); (c) the verifier assignment carries the round's changed files and
the prior round's findings instead of "find the code yourself".

**Saving.** Modelled 5 / 8 / 12 units (1.3 / 2.0 / 3.1 %), plus wall time.

**Effort/risk.** M. Risk: an over-tight budget produces plans that miss context —
the counter-metric is the rejected-plan rate (`plan_quality_rejected`) and, after
item 9, accepted findings per round.

**Verify.** `orientation-cost` for `core.plan` and `wiki`, `edit-latency` for
workers. Baselines: `core.plan` `cost_share_before` 0.507 and first artifact at
19.7; wiki 0.66 / 53.3; worker `pre_edit_call_pct` 38.3 %, 99 KB of result bytes
per run in the runs above 20 calls. Targets: planner turn share < 0.35 and first
artifact < 12; wiki < 0.30; worker pre-edit calls < 25 % with edit count and test
pass rate flat.

**Workflow.** OpenSpec change, cheap-medium preset; quality + test verifier.

## 14. Name `read`/`grep`/`codemode` where the agent actually reads them

**Problem (VERIFIED).** Planners made **0 `grep` calls** in the whole slice
(1,621 bash vs 908 read); wiki made 431/718 bash calls carrying 1.36 MB of
1.79 MB; a research session made 119 of 130 calls through the shell with no
`grep` tool and no `codemode`; `bash-vs-tools` ranges 3.2 %–79.2 % per run. It is
**model-dependent**: every `pi-opencode-go-deepseek-flash` run in the digest set
made 0 `grep` calls; the `pi-opencode-go-luna` run made 38.

**Change.** State the tool surface in the assignment's first lines and in the
`read`/`grep`/`bash` tool descriptions ("`read` with offset/limit and `grep` with
a path filter are the default way to inspect code; `bash` is for builds, tests
and `openspec`; `codemode` collapses a search→filter→summarise pipeline into one
turn"), and repeat the batching rule there rather than only in the 17.6 KB
protocol document.

**Saving.** Modelled 1 / 4 / 9 units, measured together with item 13 (the shell
share is what moves).

**Effort/risk.** M. Risk: none for correctness; the risk is a prompt change that
does not survive the model's own preferences — hence the per-profile measurement.

**Verify.** `bash-vs-tools` and `tools` split by profile: bash share of calls per
role, `grep` calls per run (baseline 0 for planners), median result bytes per
exploratory call. Targets: planner bash < 40 % of calls with `grep` > 0; no rise
in failed calls.

**Workflow.** OpenSpec change (prompt + tool descriptions), cheap-medium preset;
quality verifier.

## 15. Role-scoped re-verification with the prior round's findings forwarded

**Problem (VERIFIED).** Of 21 round transitions, later rounds cost **7.198 units
/ 745 turns** against 48.087 for round 1; the named examples re-run the whole
role set for a small fix (`introduce-local-model-support-for-classification` ran
6 roles, then 7, then the same 7 again after a 21-minute fix). Roles per round
are ≤4 in 88 % of rounds, so the cost is repetition, not breadth.

**Change.** After a round whose findings were fixed, re-run only the roles that
own the files the fix touched (plus the engine-owned test-verifier), and hand the
previous round's findings and results forward as inputs. Require a bounded
minimum diff to open a new round. Depends on item 9 to be measurable.

**Saving.** Modelled 2 / 4 / 7 units; measured ceiling is 7.198 units per
snapshot.

**Effort/risk.** M. **Quality risk is the real one**: fewer verifier rounds can
hide a bug the extra round would have caught. Mitigate with the acceptance
criterion below and by keeping the test-verifier unconditional.

**Verify.** `verifier-rounds`: rounds ≥2 as a share of round-1 cost, with
accepted findings per round flat or rising. Baseline 15 % of round-1 cost; target
< 25 % **with no fall in accepted findings per round** (`verifier-findings`,
baseline 54 accepted insights in the instrumented era).

**Workflow.** OpenSpec change, cheap-medium preset; quality + test verifier.

## 16. Preflight push credentials; block once instead of retrying unchanged

**Problem (VERIFIED).** 6 `git_operations_failed` in 3 workflows, cause
`Permission denied (publickey)` on `git push`; one workflow retried at +11 s and
+12 s with nothing changed, another twice 4.5 min apart; the 2026-10-16 round
reproduced it for three more workflows, whose monitor notes each list one
workflow id 12 times (3,216 B) and cost 0.763 units of orchestrator turns to
answer — behind a ~2 h stall.

**Change.** Check push credentials non-interactively before `delivery.push`; on
an auth failure block **once** with an actionable note (which remote, which key,
how to fix); deduplicate the monitor line to one per (workflow, step, effect)
with an attempt count.

**Saving.** Reliability, not cost: 3 attempts in 23 s and a 2 h stall become one
message. Modelled 0.2 units plus $0.76 of orchestrator turns.

**Effort/risk.** S. Risk: a preflight that requires network could slow delivery —
make it a cheap `git ls-remote` with a short timeout, and never block a push that
would have succeeded.

**Verify.** `delivery-timeline` `git_failures` and the failed-attempt count per
effect; monitor notes per failed effect. Baseline: 6 failures / 3 workflows, 3
attempts in 23 s, 6 identical lines per note → 1 line.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 17. Bound the archive repair loop

**Problem (VERIFIED).** Two archive runs (110 and 58 turns) are **168 of 721
archive turns (23 %)** and both ended `attention-required`; one issued ~40
`openspec` commands (90 kB of output) and still failed, and both workflows needed
an `operator.repair` to move at all.

**Change.** At most 2 `validate`/`archive` attempts, then hand off `blocked` with
the validator output verbatim; forbid further structural repair rounds.

**Saving.** Modelled 0.3 / 1 / 2 units plus the repair round.

**Effort/risk.** S. Risk: a legitimately repairable spec is abandoned to the
developer one attempt earlier — acceptable, because the run already needed a
human at the end.

**Verify.** Archive runs with >12 calls per snapshot. Baseline: 5 runs above 12
calls (222 turns), plus the two failure runs above; target ≤1 per snapshot.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 18. Deduplicate and digest the monitor notes

**Problem (VERIFIED).** 86 notes (17.3 kB); the three delivery notes above
repeat one workflow id 12× each, and 38 of the 86 turns that follow a note only
poll (`$9.07`) while 20 make no call at all — and the reason those turns are
expensive is the cold cache they land after (RC1), not the note's 201 B.

**Change.** One line per (workflow, step, effect) with an attempt count; default
subscriptions to a digest; let a no-op note be absorbed without waking a turn.

**Saving.** Modelled $0.8 / $3 / $6 of that conversation (the $0.82 note-collapse
plus a share of the 58 wake-up turns).

**Effort/risk.** S. Risk: a digest can delay a genuine completion — keep
`blocked`/failed events immediate.

**Verify.** Note bytes and distinct lines per note; monitor notes per hour and
the cost of the turns that follow them. Baseline: 86 notes, 64 poll-only turns
($10.13), 167 no-call turns.

**Workflow.** Solo fix workflow, cheap-medium preset.

## 19. Turn and context ceiling with a convergence checkpoint

**Problem (VERIFIED).** One worker run spent **1,072 turns, 66.3814 units (17 %
of the corpus), 911,257 tokens of context** and handed off `blocked`; its second
half cost 43.217 against 23.165 for the first. Four more long runs show the same
1.87–2.9× curve, and within-run deciles rise monotonically (3.94 → 12.85 units).
The engine has no ceiling.

**Change.** A per-run turn/context ceiling (configurable, default ~200 turns or
~250 k context) that stops the run and hands off `blocked` with a convergence
summary; a checkpoint asking the run to state what remains and whether it is
converging; and an alarm on any run above the ceiling.

**Saving.** Modelled 8 / 20 / 40 units — the last three deciles of a long run are
~42 % of its cost, and this run alone is 66 units.

**Effort/risk.** M. **Quality risk:** a genuinely large task (this one was
bootstrapping the durable runtime itself) gets cut off. Mitigate: the ceiling
hands off `blocked` with the digest, it does not silently truncate, and the
default must be above the 99th percentile of *successful* runs (measure first:
`roles` gives the distribution).

**Verify.** Turns and units per run plus the blocked/completed split. Baselines:
worker turns per run 106.8 mean; the 1,072-turn outlier; second-half ratio 1.87×.
Targets: no run above the ceiling, second-half ratio < 1.3×.

**Workflow.** OpenSpec change, cheap-medium preset; test verifier.

## 20. A run's window is its session's window

**Problem (VERIFIED).** **156 runs in 38 workflows** carry turns after their
recorded completion (median tail 1,025 s, p90 5,748 s, max 63,380 s), so per-run
status, duration and cost are wrong — e.g. a run recorded "blocked, 4 minutes"
labels 45 minutes of work, and a `complete` run with a 20-second duration carries
110 turns. The freshest evidence: an env-setup run's report artifact predates its
own final draft.

**Change.** Either close a run when its session closes, or record the session
window separately so a per-run rollup can say "these turns ran after the run
ended"; make `run-window-drift` (restored in item 0) a build-time alarm.

**Saving.** None directly. It is what makes "cost per run", "stalled run" and
"cost per minute" trustworthy.

**Effort/risk.** M. Risk: a resumed session legitimately continues after a run
closes — the fix must *record* the drift, not forbid the resume.

**Verify.** `run-window-drift`. Baseline 156 runs / 38 workflows; target 0
unexplained tails.

**Workflow.** OpenSpec change, cheap-medium preset.

## 21. Make a wake-up cheap: task reference, existence primitive, keyed polls

**Problem (VERIFIED).** `start_workflow` was called 54 times for 44 workflows
with 163,350 B of arguments (93 % `task` text paid as output and re-carried for
the rest of the session); 12 calls were refused, 8 of them "working tree must be
clean", two consecutively; `read` failed 24 of 41 times, **22 ENOENT**, guessing
`openspec/changes/<id>/proposal.md` in five repositories; wrong-id polls
(`add-environment-instances` vs the real `add-environment-instance-lifecycle`)
because the two tools do not agree on one identifier.

**Change.** `start_workflow` accepts a task reference (change path or "the
previous message"); add an existence/listing primitive for a repository's
changes; make `list_workflows` and `workflow_status` agree on one identifier and
let `workflow_status` take several ids (the compact+revision half is item 4);
report the dirty paths on a clean-tree refusal.

**Saving.** Modelled $2 / $6 / $12 of that conversation.

**Effort/risk.** M. Risk: a reference that resolves to the wrong change — require
the resolved change id to be echoed back.

**Verify.** `failed-chains` for `read` and `workflow_status`, argument bytes on
`start_workflow`, refusal count. Baselines: 58/479 failed calls, 22 ENOENT,
163,350 B of args, 12 refusals. Targets: ENOENT < 3, refusals < 4, args < 40 kB.

**Workflow.** OpenSpec change, cheap-medium preset.

## 22. Run the archive happy path in the engine again

**Problem (VERIFIED, hypothesis on the counterfactual).** The archive step is a
model run for a two-command job: 78 runs, 721 turns, 350 calls, **1.8487 units**;
72 of the 78 runs use ≤6 calls (487 turns, 1.79 units). In
2026-07-27…2026-08-14, 32 workflows carry a `delivery.archive_started` →
`archive_completed` pair (mean **18.2 s**, min 9.7, max 35.2, **no tokens**) with
no emitter in the current source. Caveat from `02e` itself: `archive`-role runs
with turns exist in the same window, so the two may have coexisted — settle it
before building.

**Change.** Make `openspec validate --strict` + `openspec archive --yes` (+
`validate --all`) a `delivery` effect and spawn the `archive` role only when the
command fails.

**Saving.** Modelled 1.0 / 1.6 / 1.85 units and ~487 turns for the passing runs;
the failure tail is item 17.

**Effort/risk.** M. Risk: the effect must not archive a change the engine should
have blocked — keep the wiki gate and the validator before it.

**Verify.** First a one-hour spike: read the old effect path's code in git
history to confirm it did the same work. Then `delivery-timeline` +
archive turns/cost per workflow; target ~0 turns for a passing archive, effect
wall time comparable to 18.2 s.

**Workflow.** OpenSpec change, cheap-medium preset; quality verifier.

## 23. Fix the harness reader, and make a source that parsed nothing fail the build

**Problem (VERIFIED).** 9 `harness.*` files report `records = 0`, `parsed = 0`,
note "unreadable: unable to open database file" — while holding **2,263
assistant turns and 2,803 tool results**, the only place in the snapshot with
stop reasons, thinking tokens, per-call result sizes and argument digests. The
pinned build is **2,263 turns (+6.7 %) and 2,804 calls (+11 %)** smaller than a
repaired rebuild of the same snapshot; every per-role total in every deep dive is
a lower bound, and `02g`'s whole slice was unreachable from the dataset.

**Change.** Open WAL stores with `immutable=1` (or copy and set
`PRAGMA query_only`), and make `skipped`/`source-gaps` a build alarm: a source
file whose parse yields 0 rows is an error, not a note.

**Saving.** None directly; it restores the only per-turn/per-call evidence the
review depends on.

**Effort/risk.** L. Risk: an immutable open ignores a live `-wal` — acceptable
for a snapshot, and the alternative is 0 rows.

**Verify.** `analyze.ts source-gaps` → 0 rows and `coverage` `has_transcript = 1`
for the workflows with stores; rebuild totals ≈35,800 turns / 28,308 calls.

**Workflow.** Solo fix workflow, cheap-medium preset (small, self-contained, with
a test that a WAL store with no `-shm` parses).

## 24. Model tiering for mechanical steps — measure, then pin

**Problem (VERIFIED cost, unverified counterfactual).** Four premium runs hold
17.7 units (4.5 %): three identical 27-turn plans at 1.7139 / 0.0416 / 0.0397
(41–43×) and two `pi-copilot-opus` consolidations at 12.9088 units (99.5 % of
the consolidator slice). Profile `pi-eon-sonnet` carries 72.348 units over 5
runs, one of them the 66.38-unit run. Free/flat-rate profiles are not zeroed:
`pi-opencode-free` carries $1.5414 over 52 runs and 0 over 91 — so cost-per-run
across profiles is biased by model resolution.

**Change.** Pin the mechanical steps (plan consolidation, wiki drafting, triage,
mechanical edits) to the cheap-medium pool by default, route up only on a
measured trigger (previous plan rejected, change touches > N files, a prior
verifier finding), and make the classifier's per-step choice visible. **Measure
first**: run the same plan/consolidate task on both pools and compare
`plan_quality_rejected` and accepted findings. Do not treat the 1,072-turn run as
evidence for the tier — it was bootstrapping the runtime.

**Saving.** Modelled 20 / 40 / 70 units (5–18 %), **quality-gated**: if the
rejection rate rises, the saving is negative.

**Effort/risk.** M, **highest quality risk in this backlog**. It is the only item
that trades plan quality for money directly.

**Verify.** Cost per plan that reaches `plan_quality_passed` without a
`plan_quality_rejected`, split by pool, plus the rejection rate per pool.
Baseline: 5 rejections in 4 workflows (all Jul/Aug), premium plan runs 1.7139
each.

**Workflow.** Solo fix workflow with an explicit A/B, cheap-medium preset; quality
verifier.

## 25. Per-workflow telemetry that survives the whole run

**Problem (VERIFIED).** **21 of 86 modern worker runs** record no turn, no call
and no cost (17 of them on 13–15 Oct), so 63 % of the worker slice's cost cannot
be attributed to a single tool call; the same 13–15 Oct worktree telemetry files
hold a single `effect.result` line each while the 16 Oct files hold everything.
Three workflows named in the brief (`env-setup-staged-config-root`,
`tui-mouse-navigation`, `orchestrator-event-subscriptions`) have one
`workflow.started` row and nothing else — today's push failures are not
observable at all.

**Change.** Keep the per-workflow runtime telemetry for the whole run (buffered
and flushed on close, or written per turn), and record the delivery/publication
failures whose stores the snapshot excludes.

**Saving.** None directly; it is what makes 21 runs and a five-week delivery
blind spot measurable.

**Effort/risk.** L. Risk: telemetry volume and secret leakage — reuse the
existing bounded/redacted envelope, never the raw payload.

**Verify.** Turns/calls present per modern worker run in the next snapshot.
Baseline: 21 of 86 empty; target 0.

**Workflow.** OpenSpec change, cheap-medium preset; test verifier.

---

## Dependencies and ordering

- **Item 0** (shipped) is a prerequisite for reading `run-window-drift`,
  `source-gaps` and `delivery-timeline` at all, and for `bun run type-check`
  passing.
- **Item 1** (telemetry shape) precedes 6, 7, 12, 15, 16 and 21: without
  arguments, sizes and failure kinds those items can be *implemented* but not
  *verified*.
- **Items 9 and 10** (round and triage/gate events) precede 14 ("did role-scoped
  re-verification lose a finding?") and 24 ("did the cheap pool make plan quality
  worse?").
- **Item 23** (harness reader) should precede any review that reads transcripts,
  and it changes the denominator: after it the baseline is ≈35,800 turns, so
  every figure in this document must be re-expressed then.
- 4 and 21 are the same tool surface and should ship together if the same
  Workflow server module is touched; otherwise 4 first (it is the larger term).
- 19 depends on 1 only for the context measure; it can ship with the turn counter
  alone.

## Suggested workflow types

- **Solo fix workflows** (one file or one behaviour, cheap-medium preset): 1, 2,
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17, 18, 23.
- **OpenSpec changes** (a contract or several call sites): 13, 14, 15, 19, 20,
  21, 22, 24, 25 — each with a quality verifier, and a test verifier for 15, 19,
  22, 24, 25.
- Nothing in this backlog should be started before item 1 lands, except 0
  (shipped) and 23 (independent and about the measurement itself).
