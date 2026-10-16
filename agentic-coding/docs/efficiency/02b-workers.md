# Efficiency deep dive 2b — workers

Analysis only: nothing under `src/`, `packages/` or `agent-definitions/` was
changed by this step. Every number below comes from the pinned dataset
`~/agentic-coding-efficiency-evidence/latest/dataset/dataset.sqlite` (built
2026-10-16T12:35Z) and, where the dataset is silent, from the raw snapshot's
transcripts (`worktrees/*/harness.sqlite`). No transcript text, tool argument or
tool result is reproduced here — only ids, indexes, counts and classifications,
in my own words.

## Summary

The worker slice is **136 runs, 14,433 turns, 9,829 tool calls (918 failed) and
232.44 of the dataset's 391.02 cost units (59 %)**. One warning before the
findings: **63 % of that cost (147.12 units) sits in 50 runs whose per-turn tool
record does not exist**, and another **29 % (66.38 units) sits in a single
1,072-turn run**. Only 18.94 units (8 %) are spread over the remaining 64
measurable runs, so the ranking below is deliberately split between "big and
measurable" and "typical and measurable".

| # | finding | measured impact | share of slice | conf. |
| --- | --- | --- | --- | --- |
| W1 | One worker run ground through 1,072 turns, 4 attempts and a ~910 k-token context, then handed off blocked | 66.38 units, 98 min | 28.6 % | high |
| W2 | Context is never compacted, so cost grows ~quadratically in turns (cache-read is 99 % of worker tokens) | second half of a run costs 1.9–2.9× the first; decile 10 is 3.3× decile 1 | ~40 % of attributable cost | high |
| W3 | 78 % of worker turns issue exactly **one** tool call, against an explicit protocol instruction | 7,328 of 9,407 turns | — (cost multiplier) | high |
| W4 | Orientation before the first edit eats ~44 % of calls and ~67 % of result bytes in the 5 runs with full evidence | 29.4 calls/run slice-wide; 38 % of calls and 99 KB in the 59 runs with >20 calls | — | high |
| W5 | 55 % of argument-visible bash calls invoke a command a dedicated tool already covers (18 % are direct single-purpose substitutes) | 308 of 557 bash calls (`grep` 111, `sed` 104, `ls` 37, `cat` 37, `wc` 8, `find` 6, `head` 4, `tail` 1); 86 of 476 verified single-purpose | — | high |
| W6 | 918 failed calls (9.3 %); `edit` fails 17.6 % of the time, and 9 of 22 errors in one run were wrong-root paths | 292 failed edits, 525 failed bash | 9.3 % of calls | high |
| W7 | Worker runs park: 25.9 h of >60 s gaps in the modern slice, two 13.8 h runs, 2.2 h waiting on human answers | 2 runaway wall-clock outliers | wall only | med |
| W8 | The same bug was attacked by 5 separate workflows in 22 min on 2 Oct; 21 modern worker runs have no per-turn record at all | 6 worker runs, 3 of them ≤4 turns | ~0 units, 219 turns | med |
| W9 | Cost is essentially independent of change size: 0.00036 units per changed line for a 313-line fix vs 0.000028 for a 7,650-line one | 3 of 3 comparable pairs | — | med |

## Slice and method

### Slice

`v_runs.role IN ('worker','recovery')` — 136 runs (135 worker, 1 recovery) in
122 workflows. Joined to `v_turns` / `v_tool_calls` on `run_id`:

| partition | runs | turns | calls | cost | analysable? |
| --- | --- | --- | --- | --- | --- |
| legacy telemetry (`run_label` ends `-legacy`) | 50 | 5,026 | 372 | 147.12 | **no** — see below |
| modern, with turns | 65 | 9,407 | 9,457 | 85.32 | yes, partly |
| modern, no per-turn record | 21 | 0 | 0 | 0 | no |
| **slice total** | **136** | **14,433** | **9,829** | **232.44** | |

Within the analysable part:

- `introdcude-pi-durable`, worker attempt 2, 2 Oct, profile `pi-eon-sonnet`
  (claude-5-sonnet): 1,072 turns, 1,192 call rows, **66.38 units**.
- everything else modern: 64 runs, 8,335 turns, **18.94 units**.
- the 5 workflows that still have a pi-durable transcript and a modern telemetry
  file (`fix-markdown-live-jump`, `orchestrator-tool-hints-and-model-gate`,
  `fix-compaction-trigger-and-settings`, `efficiency-step-1-dataset`,
  `fix-event-bus-missed-transitions`) — 820 calls, 0.768 units, 86 min of worker
  wall time. These are the only runs where I can see arguments *and* results.

The slice's cost is 59 % of the dataset, but the date range is wide: 32 of the
136 runs are July, 54 August, 10 September, 19 October. The October 13–16
workflows (`show-in-progress-tool-calls`, `fix-collapsed-sidebar-regression`,
`fix-env-tools-for-all-runs`, `fix-abort-blocked-and-queued-prompts`,
`fix-compaction-settings-unavailable`, `fix-test-config-isolation`,
`add-debug-subagent-requests`) have **no turns, no calls and no cost**: their
worktree telemetry file holds a single `effect.result` line each.

### Method

1. Dataset queries: slice size and coverage; per-run cost/turn/call totals; tool
   mix, failure mix and error classes; repeated calls and repeated reads by
   `args_hash`; calls-per-turn; first-edit position; per-run turn gaps; context
   growth by within-run turn decile; cache-read share; result-size and duration
   histograms.
2. Transcript analysis of all 5 surviving pi-durable conversations (~1,600
   entries): per-call argument JSON, per-call result length from the matching
   `pi.tool-result`, per-call wall time from the assistant/result timestamps,
   command classification, repeat detection, first-edit position.
3. Change size per workflow from the squash-merge commits in this repository
   (`git show --numstat`), to get cost per changed line. `fix-event-bus-missed-transitions`
   has no commit yet (still running at the snapshot).
4. Three new reusable queries were added to
   `scripts/efficiency/analyze.ts` (`edit-latency`, `bash-vs-tools`,
   `stalled-runs`) with tests; they are the mechanical part of W4, W5 and W8.

Cost is in the dataset's provider cost units (the same unit the
`00-data-inventory.md` headline uses, 391.02 for this build). Wall time comes
from turn or transcript timestamps, never from `runs.duration_ms` (which is
empty for the whole slice).

### Runs read closely

Full transcripts (every entry, every call index):
`fix-markdown-live-jump` run `8aac1ec8-5ece-4ce6-b5d8-89d9af038170` (142 calls,
112 turns), `orchestrator-tool-hints-and-model-gate` run
`5edc8349-3506-459b-8e5f-453a88d0f9e6` (148 calls, 80 turns),
`fix-compaction-trigger-and-settings` run
`72d5d65c-0189-45f8-a4d3-81f5d32cda67` (222 calls, 169 turns),
`efficiency-step-1-dataset` run `50033437-dd18-4959-a33f-a2fcdf35d531` (200
calls, 139 turns) and `fix-event-bus-missed-transitions` run
`e33439f5-8575-4807-a6f1-3ed4b69924fb` (108 calls, 87 turns, still running).

Aggregate inspection of every worker run's turns, calls, errors, gaps and
tool mix, plus a named look at the outliers: `introdcude-pi-durable` run
`e06de610-b745-466f-89a6-5d7734c2ca4c` (the 1,072-turn run), the two overnight
runs `worker-a24b2702` (`show-in-progress-tool-calls`) and `worker-07fe97f2`
(`fix-collapsed-sidebar-regression`); `improve-test-performance` (the 15.4 h
gap); `fix-tool-exposure` and `provide-ask-jev-tool-for-all-agents` (the two
65/54-minute human waits); `provide-ask-jev-tool-for-all-agents` run
`5e878ae3-473b-46ba-8715-a8d2e71cd219` and `research-pi-durable` run
`15b4e787-845a-425c-8b85-ed17935128e7` (94.6 % and 92.1 % pre-edit orientation);
and the five same-title `verif*` workflows of 2 Oct.

### Assumptions

- A run whose second half costs 1.9–2.9× its first half is dominated by context
  re-send, not by harder work; I did not verify this per call, only per run.
- "Pre-edit" means before the first `edit`/`write` **call**, not before the
  first successful edit.
- "Digest-visible" bash calls are the 557 with an `args_hash`/`args_digest`;
  they all come from the five worktree-telemetry workflows, so every bash
  argument statement is a statement about the recent worker shape.
- A 13.8 h span with no intervening event is counted as wall time, not as work;
  I do not attribute cost to it.
- The three queries I added are the only code change; recommendations are
  deliberately **not** implemented, per the step's brief.

## Findings

| id | title | impact | kind |
| --- | --- | --- | --- |
| W1 | A 1,072-turn worker loop that ended blocked | 66.38 units (28.6 % of slice, 17 % of dataset), ~98 min | engine + prompt |
| W2 | No compaction, so cost is quadratic in turns | 1.9–2.9× per-run growth; 99 % cache-read | config |
| W3 | One tool call per turn is the norm | 78 % of turns; 7,328 single-call turns | prompt |
| W4 | Orientation before the first edit | 44 % of calls, 67 % of result bytes (5 runs) | task shape |
| W5 | bash instead of `read`/`grep` | 308 of 557 digest-visible bash calls (86 verified substitutes) | prompt / tool definition |
| W6 | Failure tax: `edit` 17.6 %, bash 11.2 %, wrong path roots | 918 failed calls | tool definition |
| W7 | Parked runs and human waits | 25.9 h >60 s gaps; 13.8 h outliers | engine |
| W8 | Repeated work across workflows and lost telemetry | 6 worker runs, 219 turns; 21 runs | engine |
| W9 | Cost ∝ turns, not ∝ change size | 3.6e-4 vs 2.8e-5 units/line | task shape |

### Confidence, and why

| id | conf. | why |
| --- | --- | --- |
| W1 | high | the units, turns, token counts and `blocked` status are exact dataset rows and the run id is unambiguous; only the split between "genuinely hard" and "avoidable" is judgement |
| W2 | high | cache-read is measured, the within-run decile and half-vs-half curves are computed from the same rows, and the compaction event count (19, two workflows, none modern) is a direct query |
| W3 | high | `turns.tool_calls` comes from the harness/telemetry that observed the turn; the denominator (9,407) and numerator (7,328) are the same table |
| W4 | high | two independent measurements agree (dataset `edit-latency` across 59 runs, and per-call transcript indexes in all 5 conversations) |
| W5 | medium-high | the digest-based 55 % is exact but only names a command head, so I read the commands to get the 18 % floor; the model split rests on 5 runs, only one of which is non-deepseek |
| W6 | high on counts, medium on attribution | failure counts and error texts are exact; "a failed edit costs a full turn" is inferred from the transcript's one-call-per-turn rhythm, not measured |
| W7 | medium | gaps and question durations are exact timestamps, but I cannot tell a parked process from work on the two overnight runs because their runtime telemetry is gone |
| W8 | medium | the same-title cluster is a direct query; whether it was avoidable depends on whether the earlier workflow really addressed the same cause, which the data does not say |
| W9 | medium | the unit totals and `git show --numstat` line counts are exact, but three workflows is a small sample and one (`efficiency-step-1-dataset`) is an outlier in size |

### W1 — one worker run consumed 29 % of the slice and produced a blocked handoff

`introdcude-pi-durable`, worker run `e06de610-b745-466f-89a6-5d7734c2ca4c`
(attempt 2 of 4), 2026-10-02.

- 1,072 turns, 1,192 call rows (667 `codemode`, 573 `bash`, 134 `read`, 83
  `edit`, 81 `write`, 3 `developer_question`), 298 M cache-read tokens, cost
  66.38 units — 28.6 % of the worker slice and 17 % of the whole dataset.
- Context per turn reaches **910,143 cached tokens** at turn 1,070; the average
  over turns ≥ 500 is 742 k.
- Its own within-run halves: 23.17 units in the first half, **43.22 in the
  second**.
- The run ends `blocked`. The workflow ran four worker attempts between 07:23
  and 08:40 (attempts 2 and 3 blocked, attempt 4 complete); the workflow was
  still `active` at snapshot time.
- The 5 workflows named in the assignment brief sit in the same window and cost
  0.10–0.21 units each; this run cost 66.38.

Why I call it waste rather than difficulty: the task (introducing the durable
runtime) is genuinely large, and the attempt chain is a *bootstrap* of the very
runtime the agent was running on, so some churn is expected. But 1,072 turns at
a 910 k-token context is not a large task being done well — it is a loop that
never converged, and the engine had no ceiling to stop it. The measurable part
(66 units, ~100 min, run status `blocked`) is not in dispute; the share of that
which was avoidable is a judgement.

**Verification**: add a per-run turn/context ceiling and re-run a comparable
bootstrap task; measure turns and units per run before/after, and whether the
run ends `blocked` or converges.

### W2 — nothing compacts, so cost grows with the square of the turn count

- Cache-read is **99 % of worker tokens**: 1,290 M cache-read vs 5.05 M fresh
  input and 8.3 M cache-write on the slice. Every turn re-sends the whole
  conversation from cache, so a turn's cost is proportional to the context it
  carries.
- Within every long run the second half costs more than the first:

  | run | turns | first half | second half | avg cache-read/turn |
  | --- | --- | --- | --- | --- |
  | introdcude-pi-durable | 1,072 | 23.17 | 43.22 | 356 k → 756 k |
  | introduce-local-model-support-for-classification | 1,010 | 0.22 | 0.47 | 172 k → 431 k |
  | improve-test-performance | 886 | 0.13 | 0.39 | 98 k → 315 k |
  | provide-ask-jev-tool-for-all-agents | 704 | 0.04 | 0.23 | 99 k → 268 k |
  | 48fac845… | 374 | 1.16 | 2.98 | 178 k → 369 k |

- Across within-run turn deciles the cost per decile rises monotonically from
  3.94 units (first decile) to 12.85 (last), on near-equal turn counts. That is
  a ~3.3× within-run increase, which is the signature of cost ∝ turns².
- Compaction fired **19 times in the entire dataset, all in two July/August
  workflows** (`cleanup-of-processes-after-timerange`,
  `introduce-random-score-tie-breaker`). No modern worker run compacted, not
  even the 1,072-turn one. There is one `compaction_error` event, in
  `introduce-random-score-tie-breaker`.

**Verification**: enable a compaction threshold, then re-measure the
per-decile cost curve — it should flatten instead of rising 3.3×. The
`context-growth` and `cache-hit` queries already measure the inputs.

### W3 — the protocol's "never one call per turn" is not happening

Modern worker turns by calls-per-turn (the modern partition of `v_turns` joined
to `v_runs`): **0 calls 273, 1 call 7,328 (78 %), 2–3 calls 1,534, 4–9 calls 253,
10+ calls 19.** In the 5 transcripts the ratio is 1.27–1.85 calls/turn
(`orchestrator-tool-hints-and-model-gate`, run
`5edc8349-3506-459b-8e5f-453a88d0f9e6`, is the only run that batches seriously:
14 of its 80 turns carry 4–9 calls).

The assignment brief for this step, and the product's own role brief, both tell
the worker in bold that one call per turn is the most expensive way to work and
to emit many calls per turn. The behaviour contradicts the instruction in
four of five measured runs.

Because per-turn cost scales with accumulated context (W2), collapsing three
single-call turns into one turn removes two context re-sends *and* two turns'
worth of the growth curve; the saving compounds rather than adding up. Using
the observed quadratic curve, a 40 % reduction in turn count (7,328 single-call
turns → ~2,440) implies roughly a 35–45 % reduction in cost for the same work. I give that a range rather than a number because batched turns carry more
result tokens per request.

**Verification**: A/B a prompt variant that additionally requires "at least two
independent calls per turn unless the step is a single dependent edit", then
compare `calls-per-turn` and units per run on the same task family.

### W4 — almost half the calls are spent before the first edit

- Slice-wide, for the 87 runs that made an edit, the first `edit`/`write` is at
  call **29.4 on average**. Restricted to runs with more than 20 calls
  (`edit-latency`): 59 runs, **43.2 calls (38.3 %) and 99 KB of tool-result text
  consumed before the first edit**, and two of those runs never edited at all.
  The worst cases are not only the big runs: `fix-tool-exposure` reaches its
  first edit at call 36 of 37 (94.6 %), `research-pi-durable` at 106 of 114
  (92.1 %), and a `concurrency-verifier` run spends all 77 of its calls and
  850 KB on orientation.
- In the 5 fully evidenced runs, the first edit lands at call 50 (`fix-event-bus`
  of 108), 57 (`efficiency-step-1` of 200), 61 (`orchestrator-tool-hints` of
  148), 62 (`fix-markdown-live-jump` of 142) and 130 (`fix-compaction` of 222).
  Together: **360 of 820 calls (44 %) and 1,258 KB of 1,882 KB of tool-result
  text (67 %) are consumed before the first change is made.**
- The opening move is near-identical in all five: a `pwd`/`ls`/`git log`/`git
  status` probe, then a targeted file hunt (e.g. `fix-markdown-live-jump` calls
  0–1, `fix-compaction` calls 0–4, `efficiency-step-1` calls 0–3).
- Off-target exploration is real: in `orchestrator-tool-hints` 33 of 39
  read/grep targets are not among the 8 files it edited (264 KB of 547 KB); in
  `fix-markdown-live-jump`, 4 of the 6 files it wrote were never named before
  the first edit (by a command-text heuristic: a path counts as named if it
  appears anywhere in an earlier call's arguments).
- One large result looks unused: `fix-markdown-live-jump` call 15 is `env_list`,
  the single largest result in that run at 39 KB (14 % of the run's result
  bytes), and the run never calls an environment tool again — the task was a
  markdown scroll fix. Medium confidence, because "the model did not visibly use
  it" is a proxy.

Some of that orientation is unavoidable (see *Justified*), but the worker is
rediscovering file locations the plan and task text already name.

**Verification**: `analyze.ts edit-latency` now reports pre-edit calls and bytes
per run; a prompt/task-shape change that hands the worker an explicit file list
should show `pre_edit_calls` falling while edit count and test pass rate hold.

### W5 — bash is used where `read` and `grep` exist

Across the 557 worker bash calls that carry a digest, **308 (55 %) are
single-purpose shell stand-ins for a dedicated tool**: `grep` 111, `sed` 104,
`cat` 37, `ls` 37, `wc` 8, `find` 6 (`echo` 46, `mktemp` 45 and `python3` 27 are
excluded as not coverable). In the same runs the dedicated tools were used
`read` 66 times and `grep` 38 times.

That digest is only a command head, so I read the 476 bash commands in the 5
transcripts to see how many are *direct* substitutes for a dedicated tool (one
inspection command, no pipeline or loop): **86 (18 %)** — mostly `sed -n a,bp
<file>` and `cat`/`head`/`tail <file>`, which is exactly `read` with an offset
and limit. The remaining ~220 chained invocations (`grep … | head`, `for f in …;
do …`, multi-range `sed`) do inspection work that the dedicated tools express
less directly, so 55 % is an upper bound and 18 % is the floor.

The transcripts show this is strongly model-dependent within one worker role:

| run | profile | read | grep | bash-only `cat`/`head`/`tail`/`sed` | bash-only `grep` |
| --- | --- | --- | --- | --- | --- |
| orchestrator-tool-hints | pi-opencode-go-luna (gpt-6-luna) | 45 | 38 | 0 | 0 |
| fix-compaction | pi-opencode-go-deepseek-flash | 8 | 0 | 43 | 2 |
| fix-event-bus | pi-opencode-go-deepseek-flash | 11 | 0 | 11 | 1 |
| fix-markdown-live-jump | pi-opencode-go-deepseek-flash | 2 | 0 | 24 | 3 |
| efficiency-step-1 | pi-opencode-go-deepseek-flash | 0 | 0 | 2 | 0 |

`efficiency-step-1` additionally shells out to `python3` 4 times and
`fix-compaction` 16 times, mostly for text substitution that the `edit` tool
does. Separately, `fix-markdown-live-jump` writes 3 files through
`cat > … <<EOF` heredocs instead of the `write` tool (two scratch tests and one
under `/tmp`), `fix-compaction` 5 (mostly under `/tmp`) and `efficiency-step-1`
3 (a debug script plus its own run output file).

**Verification**: `bash-vs-tools` counts this per run (digest-based, upper
bound); a tool-definition or prompt nudge ("use `read`/`grep`; bash only for
commands") should drive the coverable share down. Note the honest
counter-argument in *Justified*.

### W6 — the failure tax

- 918 of 9,829 calls failed (9.3 %; 10.1 % of the 9,132 calls with a known
  outcome). By tool: `bash` 525/4,705 (11.2 %), `edit` 292/1,661 (**17.6 %**),
  `read` 58/2,013 (2.9 %), `codemode` 35/1,078, `herdr_pane` 5/5, `ask_jev` 2/2.
- In the transcripts, every non-bash failure is an `edit` or a path/IO error;
  the `edit` error texts are "oldText not found / not unique / edits[i] and
  edits[j] overlap". 12 of 108 edits failed in the 5 runs (11 %). Each failure
  costs a full turn to re-derive the exact text, and the new results must be
  re-read into context — so the true cost is a turn plus its context, not a
  retry.
- `orchestrator-tool-hints-and-model-gate` (run
  `5edc8349-3506-459b-8e5f-453a88d0f9e6`) is an outlier at 22 errors of 148 calls
  (14.9 %).
  **Nine of those 22 (41 %) are the same mistake**: `read`/`grep` called with a
  repo-root-relative path (`src/agent-host/orchestrator.ts`, `src/tui/settings`,
  `test`) while the package lives one level down under `agentic-coding/`; the
  agent then tried the `agentic-coding/…` form. The tool answers
  `ENOENT … No such file or directory` with no hint of the near miss.
- Retry-without-change is rare: no `edit` failed and then succeeded with an
  identical argument hash; only one bash command failed twice in the same run
  (2 repeat failures across the 5 runs). The failure tax is *volume*, not loops.
- Timeouts are rare but real: 3 slice calls hit exactly 300.1 s and failed (2
  `bash`, 1 `codemode`); 42 calls in the older span-sourced runs exceed 60 s.

**Verification**: instrument `edit` to report the nearest matching text on
failure and to suggest the nearest existing path on ENOENT, then track
`edit` failure rate (target: 17.6 % → under 8 %) and the wrong-root error count.

### W7 — parked runs and human waits

- Summed per-run span (first to last turn) for the 65 modern runs: **2,831 min
  (47 h)**, with 25.9 h of that in gaps longer than 60 s (86 such gaps, mean
  intra-run gap 10.5 s).
- The largest single gap is 55,558 s (**15.4 h**) inside
  `improve-test-performance`, immediately after two `developer.question` events.
- `show-in-progress-tool-calls` (run label `worker-a24b2702`) and
  `fix-collapsed-sidebar-regression` (run label `worker-07fe97f2`) both start at
  15:34/15:37 on 13 Oct and hand off at 05:23/05:33 on 14 Oct — 13.8 h and 13.9 h
  — with no events in between and no surviving runtime telemetry.
  I cannot tell from the snapshot whether the agent worked through the night or
  the process was parked; the data to distinguish them was lost.
- Human-in-the-loop waits are visible directly: `developer_question` durations
  of 3,899 s (65 min, `fix-tool-exposure`), 3,223 s (54 min,
  `provide-ask-jev-tool-for-all-agents`), 524 s and 422 s. Four
  `prompt_wait_timeout` events exist (all July).
- 21 modern worker runs (17 of them on 13–15 Oct) have no turns at all, so for
  those the entire worker activity is unmeasurable while the durable run row
  still reports a start and a completion.

**Verification**: emit an engine event when a run has no turn for N minutes
(so a park is distinguishable from work after the fact), and alarm on
question-wait time.

### W8 — the same work started five times, and telemetry that disappears

- On 2 Oct between 09:18 and 10:16, five separate workflows were created for the
  same defect ("the verifier does not spawn after the gate"):
  `verfication-doenst-spawn-even-if-gate-requires-it`,
  `verifers-dont-get-spawned-after-gate`, `fix-verfier-spawning-after-gating`,
  `fix-verifier-spawning-after-successfull-gating`,
  `fix-verifier-spawning-when-gate-succeeds`. Six worker runs in total, 219 turns, and
  — because none of those runs' turns carry a usage counter — 0.00 recorded cost.
  Three of the six runs produced 1, 1 and 4 turns, so the waste is workflow churn
  and wasted turns (`fix-verifier-spawning-when-gate-succeeds` alone holds 213 of
  the 219), not units.
- Related and larger: 21 of 86 modern worker runs have no per-turn record, and
  the 50 legacy runs have turns whose `tool_calls` column is 0 for every row and
  whose 372 call rows are all error rows. So 63 % of the slice's cost cannot be
  attributed to a single tool call.

**Verification**: a gate that refuses a new workflow whose title matches an
open one (or requires the existing one to be closed) is measurable as the count
of same-title workflows per week.

### W9 — cost tracks turns, not the size of the change

| workflow | worker units | files | +lines | −lines | units per line |
| --- | --- | --- | --- | --- | --- |
| fix-markdown-live-jump | 0.112 | 5 | 313 | 1 | 3.6e-4 |
| orchestrator-tool-hints | 0.176 | 7 | 555 | 43 | 2.9e-4 |
| fix-compaction-trigger-and-settings | 0.171 | 9 | 592 | 43 | 2.7e-4 |
| efficiency-step-1-dataset | 0.213 | 34 | 7,650 | 1 | **2.8e-5** |

A change 24× larger than `fix-markdown-live-jump` cost 1.9× as much. Per call
the 5 transcripts average 0.94 cost-milliunits. The corollary is uncomfortable
for any "small change = cheap" intuition: a 5-file TUI fix and a 9-file
behaviour change cost the same, because both are dominated by orientation and
verification (W4, W5, W6).

**Verification**: track units per changed line per workflow; a task shape that
front-loads the file list should move the 5-file cases toward the 34-file case.

### Cost of the checks themselves

I checked the brief's hypothesis that full test suites are re-run for tiny
edits. In the 5 transcripts: **13 invocations** of a bare whole-suite command
(`bun run test`) — `fix-markdown-live-jump` 3, `orchestrator-tool-hints` 9,
`fix-compaction-trigger-and-settings` 1 — against 108 edits. Measured cost of
those commands: 5.6 min in `fix-markdown-live-jump` (30 % of its 18.9 min run;
a full suite run is ~1.9 min), 2.2 min for the single run in `fix-compaction`,
and only 1.4 min for all nine in `orchestrator-tool-hints`, where the suite sits
behind a `biome check --write` in the same `&&` chain and usually never starts.
Targeted runs are far more common: 23 `bun test <path>` in
`fix-markdown-live-jump`, 26 in `fix-compaction`, 12 in `efficiency-step-1`.
Type-check ran 17 times across the 5 runs (1–6 per run), whole-repo lint
(`bun run lint` or `bunx biome check .`) 21 times (0–6 per run), build 10 times,
and path-scoped `biome check --write` 13 times. Those are the repository's own
documented checks and the protocol requires type-check and build once per
change, so the only compressible part is running the whole suite after every
small edit. **Running the full suite repeatedly is a real but modest effect
(≈2–6 min per affected run); it is not the main cost.**

## Justified — looked wasteful, but is not

1. **`developer_question` calls that take 65 and 54 minutes.** That is the
   developer, not the agent. It is the correct use of the tool (the alternative
   is guessing) and is only a problem because the run is parked meanwhile.
2. **`fix-compaction` and `efficiency-step-1` reads of 12–21 KB.** These are
   source files read once; `orchestrator-tool-hints` reads are all ranged (45 of
   45) and its 41 KB read is a single large source file. There is no evidence of
   whole-file reads where a range would do: the 15 whole-file reads run 1–44 KB
   and the largest ranged read is 41 KB (526 KB over 66 reads in the 5 runs),
   which is normal source-file size.
3. **Repeated bash `grep`/`sed` in pipelines.** 111 `grep` and 104 `sed` calls
   among the 557 digest-visible ones, but 390 of the 476 transcript commands are
   chained (`grep … | head`, `sed -n a,bp` inside a loop, `for f in …`). A
   dedicated tool cannot express those directly; only the 86 verified
   single-purpose invocations are unambiguous waste.
4. **`mktemp`/`HOME=…`/`AGENTIC_CODING_CONFIG_DIR=…` prefixes** (26, 26, 20, 11
   and 0 per run). These are the isolation the repository's own guidance
   demands; they add bytes, not waste.
5. **`echo`-heavy bash in `efficiency-step-1`** (45 calls): that worker was
   generating fixture and dataset files programmatically, where shell loops are
   the honest tool.
6. **Heavy `codemode` use in the 1,072-turn run** (667 of 1,192 call rows).
   `codemode` is *the* batching tool and its 1,058 s total is small. The run's
   cost is context, not tool choice.
7. **The four-attempt worker chain on `introdcude-pi-durable`.** The task was to
   build the durable runtime that the attempt was itself running on; retries
   after a blocked attempt are defensible. What is not defensible is 1,072 turns
   in one attempt (W1).
8. **The 13.8 h wall on two 13 Oct runs.** With zero surviving runtime events,
   13.8 h is as likely an overnight park as agent work; I do not count it as cost.
9. **`biome check --write` calls** counted by my "lint" classifier (13 across the
   5 runs) are the repository's documented formatter (`bun run format`), not
   redundant linting. The 21 whole-repo lint invocations are likewise the
   repository's own gate, not an agent invention; they cost seconds each.
10. **One identical call repeated 15 times** (`orchestrator-tool-hints`, 10.1 %
    of its calls) is the worst repeat rate in the slice; the other four runs are
    at 0–2.8 %. Repeat-call waste is not a general problem here.

## Data limits

- **63 % of slice cost has no call-level record.** The 50 `-legacy` runs
  (5,026 turns, 147.12 units) have `tool_calls = 0` on every turn row and their
  372 call rows are all error rows. Calls-per-turn, repeats, byte volume,
  duration and model are all unrecoverable for them. Any statement about
  "worker tool behaviour" is a statement about the 36 % that survives.
- **No result sizes for the modern slice.** All 3,956 `telemetry.main-store`
  calls and all 820 `telemetry.worktree` calls have `result_bytes IS NULL`; only
  `traces.otel-tui` (the older source) carries sizes, which is why the dataset's
  13.7 MB total is an artefact of the old source. The "large results never used"
  question is answerable **only** from the 5 harness conversations.
- **No call durations for the modern slice either** (0 of 4,776), so the
  dataset cannot rank slow commands outside the 5 transcripts.
- **697 calls (all `traces.otel-tui`) have `ok IS NULL`** — no outcome reported.
- **The recent worker runs are the least covered.** 17 of the 19 October runs on
  13–15 Oct have no turns, no calls and no cost; their worktree telemetry files
  hold one `effect.result` line each while the 16 Oct ones hold everything. I
  could not establish why.
- **Harness coverage**: 5 of the 16 surviving worktrees have a `harness.sqlite`
  (`orchestrator-tool-hints-and-model-gate`, `fix-markdown-live-jump`,
  `fix-event-bus-missed-transitions`, `fix-compaction-trigger-and-settings`,
  `efficiency-step-1-dataset`) — the brief names three of them; I used all five.
  `00-data-inventory.md` still says "3 of the 14 worktrees", which is out of date.
- **Numbers that disagree with the brief and the inventory doc.** The brief
  says 14,330 turns / 9,675 calls / 954 failed / ~231 units; I measure 14,433 /
  9,829 / 918 / 232.44. The failed-call difference is 3.8 % and the call
  difference 1.6 %; I did not chase them further than confirming the join
  (`v_runs.role` → `v_tool_calls.run_id`) is the same on both sides.
  `docs/efficiency/00-data-inventory.md` is a **different, earlier build**:
  666/1,257/34,820/27,077 and 437.7382 units versus the pinned dataset's
  668/1,238/33,137/25,024 and 391.0161. The 46.7-unit (11 %) cost gap is larger
  than "slightly", and the brief's "231 of 437" mixes a slice number from this
  build with a total from that one. Reported as found, not smoothed.
- **Could not determine**: cost per commit for the 8 workflows whose worker runs
  have no per-turn record (`show-in-progress-tool-calls` 865 lines,
  `fix-abort-blocked-and-queued-prompts` 1,669, `fix-env-tools-for-all-runs`
  1,066, `fix-test-config-isolation` 727, and four more); whether a specific tool
  result was actually read by the model (only a "never referenced again" proxy);
  why the 1,072-turn run looped (its turns come from the span source, so they
  carry no `stop_reason` and no thinking tokens); and whether `fix-event-bus-missed-transitions`
  (still running, 87 turns, 0.096 units at the snapshot) converged.

## Recommendations ranked by expected saving per effort

| rank | change | kind | expected saving | verification |
| --- | --- | --- | --- | --- |
| 1 | Give a worker run a hard turn/context ceiling and a convergence checkpoint (e.g. stop and hand off blocked at N turns or M tokens of context, whichever first) | engine | the tail runs are where the money is: one run = 28.6 % of the slice; the last three within-run turn deciles = 42 % of attributable cost | turns and units per run, plus the blocked/completed split, before and after |
| 2 | Turn compaction on for worker runs (a threshold well below 910 k tokens) | config | flattens the within-run decile curve (currently 3.3×); a run at 1,000 turns should cost far less than 2× a run at 500 | per-decile cost curve and cache-read per turn |
| 3 | Re-word the batching instruction and enforce it (require ≥2 independent calls per turn; make a single-call turn the exception an agent must justify) | prompt | 78 % of turns are single-call; a 40 % turn cut implies ~35–45 % cost cut on the same work | `calls-per-turn` and units per run on a fixed task set |
| 4 | Make `edit` failures self-correcting (return the nearest matching text / line numbers) and make path errors self-correcting (suggest the nearest existing path) | tool definition | `edit` fails 17.6 % of the time; 9 of 22 errors in one run were the same wrong-root path | `edit` failure rate and ENOENT count per run |
| 5 | Put the plan's file list into the implementation brief and tell the worker to start editing from it | task shape | 44 % of calls and 67 % of result bytes are pre-first-edit in the 5 measured runs | `edit-latency`: `pre_edit_calls` and `pre_edit_result_bytes` |
| 6 | Steer argument-visible shell work to `read`/`grep` (one line in the tool description plus a worked example) and measure it per model profile | prompt | 86 of 476 transcript bash calls (18 %) are direct substitutes, 308 of 557 (55 %) by digest head, against 104 total `read`+`grep` tool calls | `bash-vs-tools`, split by profile |
| 7 | Emit an engine event when a run has made no turn for N minutes, and surface question-wait duration | engine | 25.9 h of >60 s gaps and two 13.8 h runs are currently indistinguishable from work | gap histogram from the new event |
| 8 | Refuse or merge a new workflow whose title matches an open one | engine / gate | 5 same-title workflows and 6 worker runs in 22 min on 2 Oct, 3 of the runs ≤4 turns | count of same-title workflows per week |
| 9 | Keep per-workflow runtime telemetry across the whole run (the 13–15 Oct files were reduced to one line) | engine | 21 of 86 modern runs and 63 % of slice cost are currently unattributable | turns/calls present per worker run in the next snapshot |
| 10 | Add compaction/turn-budget metrics to `analyze.ts` (`context-growth` already exists) so the step-2 loop can be re-measured cheaply | tooling | makes ranks 1–3 verifiable in one query | the new queries run against the next snapshot |

## Open questions

1. **Why is a single-call turn the norm?** Multi-call turns demonstrably happen
   (253 dataset turns carry 4–9 calls and 19 carry 10+, and
   `orchestrator-tool-hints` alone has 14 of its 80 turns at 4–9 calls), so this
   is a policy the model is not following, not a hard limit. Is the role brief's batching text
   actually reaching the worker's context in the form the harness sends
   (`pi.system`), or is it being trimmed?
2. **Why did the 13–15 Oct telemetry files keep one `effect.result` line and
   nothing else**, while the 16 Oct ones kept the full runtime stream? Answering
   this is a prerequisite for measuring the next round of workers at all.
3. **What is the natural size of a compaction?** Before rank 2 is implemented it
   should be checked that compacting away 700 k cached tokens does not cost more
   in re-reads than it saves.
4. **Would batching actually pay off?** Three calls in one turn returns three
   results at once, so the next request carries more; the 35–45 % estimate
   assumes the conversation would otherwise carry those results anyway. An A/B
   is cheap to run and is the only honest answer.
5. **Is the `introdcude-pi-durable` cost a one-off (a bootstrap task) or the
   shape of every "build the platform" task?** The dataset has no second
   comparable run, so I cannot say.
6. **Why do two runs on the same day sit at 13.8 h with no intermediate
   events?** Either the engine parked them or the telemetry was dropped; the
   snapshot cannot distinguish these.
7. **Do plan-quality and verifier rounds add work to workers?** The brief asks
   about "fix rounds after verification". In this slice only `introdcude-pi-durable`
   and `verfication-doenst-spawn-even-if-gate-requires-it` have more than one
   worker run on the *same* workflow, and neither has verifier findings attached
   to the second round, so the data to answer it is not there.
