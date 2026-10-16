# Efficiency review step 2c — verifiers

Analysis only: no production code was changed. The single code change in this
step is a new read-only analysis query (`verifier-rounds`) and its test, added
so later steps can reuse the round reconstruction instead of redoing it.

Dataset: `~/agentic-coding-efficiency-evidence/latest/dataset/dataset.sqlite`
(built 2026-10-16T12:35Z). Every number below is a count, a share or a cost
from that dataset; no transcript text, tool argument or tool result is quoted.

## Summary

Verifiers are 34% of all turns, 37% of all tool calls and 47% of all input
tokens, but only 14% of recorded cost (55.29 of 391.02 provider units). The
interesting result is not their size — it is that **most of their yield cannot
be measured**, and in the era where it can be, half the rounds found nothing.

1. **Yield is unmeasured for 60% of verifier rounds.** 121 rounds across 100
   workflows; the engine emitted findings events only between 2026-07-16 and
   2026-08-14. 72 of the 121 rounds (28.98 cost, 7,081 turns) belong to
   workflows whose generation recorded no finding, verifier result, settle or
   round event at all. In the 49 instrumented rounds, **25 (51%) produced no
   finding event** and cost 6.45 of that era's 26.31 (25%). 76 of the 100
   workflows with verifier runs never emitted a single finding event.
2. **A re-verification round costs ~18× the fix it verifies.** Of 21 round
   transitions, 20 followed a worker run of ≤20 turns (0.40 cost, ~140 turns
   total) and the following verification round cost 7.17 (~1,460 verifier
   turns).
3. **57 verifier runs (13%) had every recorded tool call fail** — 2,492 turns
   and 15.04 cost (27% of the slice) spent by runs that could not read
   anything. Worst: 16/16, 13/13 and 12/12 failing bash calls in runs of 194,
   190 and 92 turns.
4. **Context, not call volume, is the cost driver.** 1,136 verifier turns ran
   above 100k tokens of context and carry 21% of the slice's cost; average peak
   context per role ranges from 38k (quality) to 137k (migration), with a
   maximum single-run context of 661k. No verifier run was ever compacted.
5. **Engine-side loops: 121 empty settles + 34 nudges** in 17/8 workflows, one
   of which re-settled 20 times in 112 seconds (median 5.9 s apart), each nudge
   re-sending the run's context.

Justified and left alone: the `change-validation-logic-for-power-threshhold`
round (6 roles, 43 finding events, 21 developer-accepted findings), the
engine-owned single full-suite run per round, a zero-finding security round,
and the 16-hour "stalls" that are the host being suspended overnight, not
agent work.

## Slice and method

**Slice.** Every run whose role contains `verifier`, from `v_runs`:
10 roles, 431 runs, 100 workflows, 11,250 turns, 9,226 tool calls,
7.85M input tokens, 3.40M output tokens, 404.5M cache-read tokens,
55.29 cost units. Share of the whole dataset (preferred rows):
35% of runs, 34% of turns, 37% of calls, 47% of input tokens, 34% of output
tokens, 21% of cache reads, 14% of cost.

| role | runs | turns | calls | turns/run | calls/turn | cost |
| --- | --- | --- | --- | --- | --- | --- |
| quality-verifier | 123 | 4,107 | 2,870 | 33.4 | 0.70 | 26.961 |
| openspec-verifier | 70 | 1,446 | 2,203 | 20.7 | 1.52 | 9.701 |
| test-verifier | 95 | 1,770 | 886 | 18.6 | 0.50 | 6.802 |
| security-verifier | 34 | 900 | 989 | 26.5 | 1.10 | 5.555 |
| usability-verifier | 50 | 1,082 | 1,026 | 21.6 | 0.95 | 5.547 |
| agents-verifier | 14 | 284 | 31 | 20.3 | 0.11 | 0.479 |
| migration-verifier | 9 | 361 | 262 | 40.1 | 0.73 | 0.123 |
| test-quality-verifier | 16 | 747 | 554 | 46.7 | 0.74 | 0.088 |
| performance-verifier | 10 | 253 | 203 | 25.3 | 0.80 | 0.029 |
| concurrency-verifier | 10 | 300 | 202 | 30.0 | 0.67 | 0.000 |

Cost splits sharply by era: 2026-07 (90 runs, 3,040 turns, 7.38), 2026-08 (249
runs, 4,634 turns, 47.08), 2026-09 (41 runs, 2,112 turns, 0.16), 2026-10 (51
runs, 1,464 turns, 0.67). **3,576 verifier turns (32% of the slice) carry
almost no recorded cost**, so every cost statement here is a 2026-07/08
statement.

**Rounds.** The engine's `attempt` field is the verification round counter, but
it is populated on only 91 of 431 verifier runs (the newer generation). Rounds
were therefore reconstructed by grouping a workflow's verifier runs whose start
times are ≤20 minutes apart; on the 91 runs that carry both, the grouping
agrees with the recorded attempt on 84 (7 mismatches, presumably a round split
by a longer gap). Result: 121 rounds; rounds per workflow 1:81, 2:17, 3:2
(1, 2 and 3 rounds; the 5-round workflows named in the brief —
`env-setup-staged-config-root`, `orchestrator-event-subscriptions`,
`tui-mouse-navigation` — exist only as stub rows in this snapshot, with no runs
at all). Roles per round: legacy mean 3.3 (1:13, 2:23, 3:35, 4:34, 5:7, 6:4,
7:4, 8:1); newer era mean 5.1 over 18 rounds (up to 8 roles). The reconstruction
is committed as `bun run scripts/efficiency/analyze.ts verifier-rounds`.

**Yield attribution.** `verification_finding` / `verification_finding_observed`
events carry a workflow, a role, a severity and a timestamp, but **no run id and
no detail** (all 262 have `detail IS NULL`). A finding was therefore attributed
to a round when its workflow matched, its role was one of the round's roles, and
its timestamp fell in [round start, next round start). Round costs come from the
runs' turns. This cannot distinguish two roles reporting the same file — the
event digest that would allow it was not recorded.

**What was read.** The dataset (turns, tool calls, events, run rollups) through
`analyze.ts` and direct read-only SQL, plus the new query; the raw snapshot's
`main-store/harness-stale-oct12.sqlite` (17 pi-durable conversations, 956 tool
calls: aggregated tool names, argument hashes and result sizes only — no content
is reproduced anywhere in this report) and `worktrees/*/telemetry.jsonl` (an
inventory of which worktrees carry `tool_input` at all). Runs read in detail
because they were the biggest or the most typical of a pattern:
`48fac845-baec-46f7-a4c4-d692f95cad15`, `cc309906-df32-4e71-8a92-00e6b0b9ba49`,
`8d8821c1-f6da-45d8-bb1b-02197628918a`,
`f9e1f14e-57d6-4630-9e46-d4f1426f7a14`, `add-comment-count`,
`change-substation-schema-to-not-include-capacity`, `improve-user-actions-ui`,
`add-logbook-logging`, `remove-min-capacity-kw`,
`change-validation-logic-for-power-threshhold`,
`introduce-local-model-support-for-classification`, `improve-test-performance`,
`introduce-usability-verifier`, `sanety-check-workflow-steps`,
`add-developer-review-ui`.

## Findings

| id | finding | quantified impact | confidence |
| --- | --- | --- | --- |
| V1 | Re-verification of a tiny fix costs ~18× the fix | 20 of 21 transitions: fix 0.40 / ~140 turns → round 7.17 / ~1,460 turns | high (numbers), medium (proxy) |
| V2 | Yield unmeasured for 60% of rounds; 51% of measurable rounds empty | 72/121 rounds unmeasured (28.98 cost); 25/49 measured rounds empty (6.45) | high |
| V3 | Runs where every tool call failed are not cut short | 57 runs (13%), 2,492 turns, 15.04 cost (27% of slice) | high |
| V4 | Deep context dominates cost; no compaction ever | 1,136 turns >100k context = 11.73 (21% of slice); peak context up to 661k | high |
| V5 | Batching unused: 44% of interior turns make exactly one call | 4,695 single-call interior turns = 17.68 cost (32%) | medium |
| V6 | Empty-settle / nudge loop churns | 121 settles + 34 nudges, 17/8 workflows; 20 settles in 112 s | medium (semantics), high (counts) |
| V7 | Test-verifier failures and durations are unclassified | 159/509 bash calls fail; duration recorded for 90 (18%) | high (counts), low (cause) |
| V8 | Failed calls are 8.2% of the slice with no retry visible | 752/9,226 failed; worst chains 21/148, 19/101, 11/217 | medium |
| V9 | Role selection widened in the newer engine | newer rounds 5.1 roles vs legacy 3.3; one round ran 8 | medium-low |
| V10 | `agents-verifier` is a dead role | 14 runs, 284 turns, 31/31 calls failed, 0.48 cost | high |

### V1 — A re-verification round costs ~18× the fix it verifies (engine, task shape)

Evidence: the new `verifier-rounds` query plus an intermediate-worker scan over
`v_runs`/`v_turns`. Of the 21 round transitions (round N → N+1) in the slice, 20
have a worker run in between of ≤20 turns; those worker runs cost 0.40 in total
(≈140 turns), and the following verification rounds cost 7.17 (≈1,460 verifier
turns at the slice's mean turn cost). Named examples: `introduce-local-model-support-for-classification`
ran 6 verifier roles in round 1, then 6 + test-verifier in round 2 after a
21-minute worker fix, then the same seven again in round 3;
`8d8821c1-f6da-45d8-bb1b-02197628918a` re-ran quality+openspec three times;
`cc309906-df32-4e71-8a92-00e6b0b9ba49` re-ran quality+openspec four times in
55 minutes.

Impact: later rounds are 7.20 of 55.29 (13%) of the slice's cost, and they
produced 8 finding events of 262. Both the cost ratio and the yield ratio point
the same way. Confidence is high on cost and turns; the "tiny" claim rests on
worker turn count as a proxy, because the dataset stores no diff size.

Recommendation (engine/task shape): after a round whose findings were fixed,
re-run only the roles that own the files the fix touched (plus the engine-owned
test-verifier) and hand the previous round's findings and results forward as
inputs; require a bounded minimum change to open a new round. Verify by
measuring rounds ≥2 cost as a share of round 1 in the next snapshot: target
under 25% of round-1 cost with no drop in accepted findings per round.

### V2 — Yield is unmeasured for 60% of rounds, and half of the measured ones are empty (engine, tooling)

Evidence: 262 finding events (156 `verification_finding` + 106
`verification_finding_observed`; 48 critical) and 54 `developer_accepted_finding`
events, all between 2026-07-16T11:39Z and 2026-08-14T08:37Z. 49 of the 121
rounds sit in workflows that emitted verification events at all; 25 of those 49
produced no finding event and cost 6.45 of the era's 26.31. The remaining 72
rounds (28.98 cost, 7,081 turns, including the entire Sep/Oct generation) carry
no yield signal whatsoever. Corroborating engine-side signal: 121
`verifier_empty_settle` + 34 `verifier_empty_settle_nudged` in 17/8 workflows,
all in the same Aug window.

Impact: cost per finding event is 0.211, per critical finding 1.15, per
developer-accepted finding 1.02 — but only over 431 runs of which 249 are
August, so this cannot be projected onto current spend. The actionable waste is
that nobody can tell whether a round found nothing or was simply not recorded.
Confidence: high on the counts, medium on the reading of "empty" (see V6 and
Data limits).

Recommendation (engine/tooling): emit one `verification_round` event per round —
workflow, run ids, round index, selected role set, triage file→role map, changed
files, findings by severity, accepted count, turns, tokens, cost — and make the
verifiers' "no finding" result an explicit recorded outcome (their briefs
already say "nothing found is a complete answer"). Verify by recomputing the
zero-yield share and the cost per accepted finding from that event alone;
acceptance criterion: 100% of rounds carry it, and the share of rounds with no
finding falls below the measured 25%.

### V3 — Verifier runs whose every tool call failed are not cut short (engine)

Evidence: 57 runs (13% of 431) have ≥3 recorded calls and *all* of them failed:
27 runs / 1,531 turns / 2.04 cost from `telemetry.main-store`, 30 runs / 961
turns / 13.00 cost from `traces.otel-tui`. The largest are
`sanety-check-workflow-steps` quality-verifier (16/16 bash calls failed, 194
turns), `add-developer-review-ui` quality-verifier (16/16, 190 turns) and its
test-verifier (12/12, 92 turns), `change-substation-schema-to-not-include-capacity`
quality-verifier (4/4, 89 turns) and openspec-verifier (5/5, 86 turns),
`fix-git-operations-and-workspace-closing` quality-verifier (9/9, 113 turns).

Impact: 15.04 cost (27% of the slice) and 2,492 turns went to runs that could
not read a file or run a command. Even if part of that cost sits in the cheap
era, 194 turns of a run with no successful tool call is not verification. The
error classes (`tool_error` 444, `error` 308 slice-wide; 186 and 127 of those
quality-verifier's) say the tool surface, not the repository, was the problem. Confidence: high on outcomes and turns;
medium on the cost share (the main-store era records almost no per-turn cost).

Recommendation (engine): after N consecutive failed calls with zero successes,
fail the run fast — retry the tool host once, then hand off `blocked` naming the
tool; never let a verifier burn hundreds of turns with no successful call.
Verify with a counter "runs with zero successful tool calls per 100 verifier
runs" (today 13) and a bound on their turns.

### V4 — Context, not call volume, dominates verifier cost (engine)

Evidence: 1,136 verifier turns carried more than 100k tokens of cached context
and account for 11.73 of the slice's 55.29 (21%); dataset-wide the same filter
accounts for 41% of all cost. Average peak context per verifier run: migration
136.5k, concurrency 100.3k, test-quality 89.9k, security 67.8k, usability 50.1k,
openspec 39.8k, quality 38.1k; the single largest is 661k tokens
(openspec-verifier, `48fac845-baec-46f7-a4c4-d692f95cad15`, whose four verifiers
spent 368 turns and 783 calls for 6.16 — the most expensive round in the slice —
whose generation recorded no finding event at all). In the `telemetry.main-store` era the interior
turns that made exactly one call averaged 100.5k tokens of context and cost
13.16 of that era's 22.76. Compaction: 7 `compaction_requested` / 6
`compaction_completed` dataset-wide, none for a verifier run.

Impact: this is the same money as V5 but a different cause — the run is long
lived and every extra turn re-reads a 100k-token context. Confidence: high on
the counters; medium on the claim that compaction (rather than a shorter
assignment) is the right remedy.

Recommendation (engine): give a verifier a bounded context — the round's changed
files and the prior round's findings only, no accumulated tool-result tail — and
record peak context per run. Verify by tracking the cost share of turns above
100k context (target <10%) and turns per verifier run.

### V5 — Turn batching is not used: 44% of interior turns make exactly one call (prompt, tool definition)

Evidence: verifier interior turns (excluding each run's final turn): 4,272 with
no tool call (cost 25.06 across eras), 4,695 with exactly one (17.68), 1,577 with
two or more (9.92). Per-role calls per turn range from 0.50 (test-verifier) to
1.52 (openspec-verifier). The counter-example shows the rule does work: the four
verifiers of `48fac845-…` made 783 calls in 368 turns (2.1 per turn) using `read`
and `bash` in parallel.

Impact: if the single-call interior turns merged pairwise into one turn, the
saving is roughly half of 17.68 cost units plus the same number of context
re-reads — call it 8-9 cost units (15% of the slice) before any change in what
the verifier reads. Confidence: medium — a zero-call turn can be genuine
reasoning, and I cannot see the calls' arguments to prove that two turns touched
independent files.

Recommendation (prompt/tool definition): the batching rule exists but sits in a
17.6 KB protocol document; repeat it as the first line of the assignment and in
the read/bash tool descriptions ("emit every independent read in one message").
Verify with calls per turn and cost per successful tool call per role; target
≥1.0 calls per turn for the review-only roles.

### V6 — The empty-settle/nudge loop is engine churn (engine)

Evidence: 121 `verifier_empty_settle` and 34 `verifier_empty_settle_nudged`
events in 17 and 8 workflows. `remove-min-capacity-kw` settled 20 times inside
112 seconds (median gap 5.9 s); `improve-user-actions-ui` 14 times over 671 s;
`add-logbook-logging` 12 over 944 s; `add-dates-to-process` 12 over 696 s. The
nudged workflows are the same set. No code path in the current checkout emits
either event name (they stop 2026-08-14), so the semantics are inferred from the
name and the timing, not read from source.

Impact: each nudge re-sends the run's context, so 155 events ≈ 155 extra agent
turns ≈ 0.76 cost units at the slice's mean turn cost — small in provider units,
but 7-16 minutes of wall time per affected workflow while the round stays open,
and the 20-in-112-seconds pattern is a loop, not agent work. Confidence: high on
counts and wall time, medium on what a settle means.

Recommendation (engine): deduplicate the settle, bound consecutive nudges to one
per run, and record why the settle was empty (no artifact, no handoff, idle
session). Verify by re-counting settles per round and the seconds a round spends
settling.

### V7 — Test-verifier: the suite runs once per round, and its results are unclassifiable (tool definition, engine)

Evidence: 95 runs, present in 93 of 121 rounds (77%); 84 workflows ran it once,
4 twice, 1 three times. 886 calls (509 bash, 308 read, 54 write); 188 failed
calls, 159 of them bash (31%). Durations exist for only 90 of 509 bash calls
(18%): 1,160 s in total, largest single command 144 s; the largest recorded
per-run total is 613 s (`introduce-local-model-support-for-classification`).
The failures are only classed `tool_error` (124) or `error` (64), and many runs
fail every call (`add-developer-review-ui` 12/12, `sanety-check-workflow-steps`
13/13, `add-status-for-git-operations` 9/9), so a broken tool surface and a
genuinely failing suite look identical.

Impact: the engine-owned single suite run per round is not itself waste (see
Justified); the waste is the 6 workflows that ran it 2-3 times, and the
impossibility of telling environmental failures from real ones — the whole point
of the role. Confidence: high on counts, low on any environmental-vs-real split.

Recommendation (tool definition/engine): for every test-verifier run record the
command digest, exit code, duration and a normalized failure signature (failing
test ids), and skip the suite for a round whose diff touches neither a test nor
a file the suite covers. Verify with "suite seconds per round", "share of suite
runs green", and "environmental failures per 100 runs".

### V8 — Failed calls are 8.2% of the slice and retries are invisible (tool definition, tooling)

Evidence: 752 of 9,226 verifier calls failed — 8.2% of the slice (quality
313/2,870; test 188/886;
usability 84/1,026; openspec 64/2,203; security 29/989; performance 21/203;
others small). Chained failures inside a single run, e.g. `f9e1f14e-…`
quality-verifier 21/148 and usability-verifier 19/101 and openspec-verifier
11/217; `add-comment-count` quality-verifier 11/11; `improve-test-performance`
migration-verifier 10/104 and performance-verifier 9/107.

Impact: a failed call is not automatically waste (a grep with no match, a file
that does not exist), so I do not claim the 752 as cost. What is missing is any
way to see a retry: 2 of 9,226 verifier calls have an argument digest.
Confidence: medium.

Recommendation (tool definition/tooling): return a machine-readable failure kind
(`not-found`, `no-match`, `denied`, `host-error`, `timeout`) instead of
`tool_error`/`error`, and keep the argument digest for verifier calls so a later
review can compute exact repeats and retries. Verify by reporting "failed calls
per 100 calls" by kind and "exact repeats per run".

### V9 — Role selection widened rather than narrowed in the newer engine (config, engine)

Evidence: legacy rounds averaged 3.3 roles (max 8) over 103 rounds, the rounds
that carry the engine's `attempt` counter average 5.1 over 18 rounds, and
`add-debug-subagent-requests` round 2 launched 8 roles (all verifier roles except
test-verifier, which is engine-owned). All nine roles are declared in
`VERIFIER_ROLES` (`src/workflow/steps/verification.ts`); the triage events that
could show the selection (`triage_role_suggested` 98, `triage_role_selected`
104, `triage_file_selected` 923) exist only for 2026-07-24..08-14 and never
appear again, so the modern selection decision is invisible.

Impact: if the newer engine reliably runs 5-8 roles where 3-4 sufficed in the
legacy era, verifier spend per round rises even if each role is unchanged. Cost
impact cannot be quantified because Sep/Oct cost is missing. Confidence:
medium-low — 18 rounds, and `attempt` exists only in the new era.

Recommendation (config/engine): require the selection to name, per role, the
changed file that put it in the round, and cap the round at the roles with a
file (plus test-verifier). Verify with "roles per round" and "findings per
selected role per round" once round events exist.

### V10 — `agents-verifier` is a dead role (config)

Evidence: 14 runs, 284 turns, 31 calls — all 31 failed — for 0.48 cost; 21 of
its 26 finding events come from a single workflow
(`change-validation-logic-for-power-threshhold`, another repository). It is not
in the current `VERIFIER_ROLES` catalog, so it survived only in configuration
used in July.

Recommendation (config): confirm no workflow definition, profile or preset still
names `agents-verifier`. Verify by grepping the compiled catalogs for the role
id; cost impact is bounded (0.48) but it is 284 turns of a role nothing owns.

## Justified — looked expensive, was not waste

- **`change-validation-logic-for-power-threshhold`: 6 verifier roles, 43 finding
  events, 21 developer-accepted findings.** The best yield in the slice; the
  accepted count alone (39% of all 54 accepted findings) justifies running six
  roles there. Cost is recorded as 0.10, so it is cheap whatever the true figure.
- **The engine-owned single full-suite run per round.** 93 of 121 rounds ran
  test-verifier once; 1,160 s of recorded bash time across 95 runs is not a
  runaway, and the role's brief forbids narrowing or repeating the suite. The
  problem is classification and the 6 workflows that re-ran it, not the role.
- **A zero-finding security round.** security-verifier has the worst cost per
  finding (1.85 over 3 findings), but its briefs say to state plainly when a
  boundary is clean, and its criticals include the `add-logbook-logging` critical
  finding. Treating "no boundary crossing found" as waste would be wrong.
- **openspec-verifier's 1.52 calls per turn and 31.5 calls per run.** It runs
  `openspec validate --strict` plus a spec-to-diff comparison; 9 finding events
  of which 3 critical in 70 runs is a normal return for a comparison role.
- **The 16-hour and 3-day "stalls".** `improve-test-performance`'s six verifiers
  all started 2026-10-01T14:14:43-14:15:03, all had a ~955-minute gap inside the
  run and all resumed within seven minutes of each other (06:15-06:22 next day);
  `introduce-usability-verifier`'s quality-verifier spans 2026-07-24T08:38 to
  2026-07-27T07:19 with 34 turns. Six independent agents stalling and resuming
  together is the host being suspended, not agent idling. What is *not* justified
  is that the engine cannot tell the two apart and keeps the round open.
- **The 17.6 KB shared protocol prompt** (`agent-definitions/instructions/workflow-agent-protocol.md`,
  ~4.4k tokens) carried by every verifier run: the slice's cache-hit rate is
  93-99% per role, and the median first-turn cache *write* is only 613-1,137
  tokens (assignment-sized), so the protocol prefix is a small, already-cached
  cost. It is still the wrong place for the batching rule (V5).

## Data limits

- **No verifier tool arguments.** 2 of 9,226 verifier calls carry an argument
  hash, both `bash`; zero `read` calls do. Exact duplicate calls and repeated
  reads of the same file cannot be proven within or across verifier roles. This
  is the single biggest limit on this slice.
- **No result sizes for 81% of verifier calls** (1,756 of 9,226) and no duration
  for 82% of bash calls, so byte-level and latency waste cannot be measured for
  verifiers. Total recorded verifier result bytes: 8.6 MB.
- **Findings carry no run id and no digest.** Attribution to a round is my
  construction (workflow + role + time window); cross-role overlap on the same
  file/topic cannot be detected at all because `detail` is NULL on all 262
  finding events.
- **Yield and cost exist only for 2026-07-16..08-14.** The Sep/Oct verifier runs
  (92 runs, 3,576 turns = 32% of slice turns) carry 0.83 recorded cost and no
  finding, round or settle events. Every yield and cost claim above is a
  Jul/Aug claim; current verifier spend is extrapolated, not measured.
- **Stub workflows.** 424 of 666 workflows in the inventory have no turns and no
  calls; the 5-round workflows named in the brief are among them. Round counts
  here (max 3 by reconstruction) undercount rounds that existed and were not
  recorded.
- **Overlap between roles is unprovable**, but the one place arguments survive —
  the `main-store` pi-durable store, 17 conversations, 956 tool calls — shows
  only 5 identical repeats (0.5%) and 7 extra same-file reads out of 49 `read`
  calls. Its tool mix is bash:722, codemode:111, read:49, i.e. a generation that
  read files through `bash`. Within those transcripts the protocol prompt body
  appears 2-3 times in 11 of 17 conversations, which is a prompt-duplication
  signal worth following in the raw store rather than in the dataset.
- **`verifier_empty_settle` / `verifier_empty_settle_nudged` have no emitter in
  the current checkout**; semantics are inferred.
- **Inventory vs dataset.** `docs/efficiency/00-data-inventory.md` headlines
  (666 workflows, 34,820 turns, 27,077 calls, 437.74 cost, 18.58M input tokens)
  are 5-12% higher than the pinned dataset (668, 33,537, 25,504, 391.02,
  16.82M). The pinned dataset is internally consistent (all-turn cost 391.376 vs
  391.016 preferred), so the checked-in inventory is stale relative to it; every
  number here is from the pinned dataset.
- **Conversation-level cost attribution.** `turns.input_tokens` is unusable for
  trace-sourced rows (2 tokens per turn); context growth was measured with
  `cache_read_tokens + cache_write_tokens`, which is the prompt re-read per turn
  and is the right proxy for this question but not a billable input count.

## Recommendations ranked by expected saving per effort

1. **Record one `verification_round` event per round** (engine, low effort,
   unlocks everything else): role set, triage file→role map, changed files,
   findings by severity, accepted count, turns, tokens, cost, peak context.
2. **Keep tool-input digests, result sizes and durations for verifier calls, and
   a machine-readable failure kind** (tooling/tool definition, low effort):
   without them duplicate-work and retry reviews are guesswork (V3, V7, V8).
3. **Do not re-run every role for a tiny fix** (engine, medium effort):
   role-scoped re-verification plus forwarded prior findings; ~7.2 cost units
   (13% of the slice) and ~1,460 verifier turns per snapshot at stake (V1).
4. **Fail fast on a verifier run with no successful tool call** (engine, low
   effort): 57 runs, 2,492 turns, 15.04 cost affected (V3).
5. **Bound the verifier's context** — round-scoped files and prior findings only,
   no tool-result tail (engine, medium effort): 21% of slice cost sits above
   100k context (V4).
6. **Make triage name a file per selected role and cap the round** (config,
   low effort): roles per round rose from 3.3 to 5.1 in the newer era (V9).
7. **Move the batching rule out of the 17.6 KB protocol into the assignment's
   first line and the read/bash tool descriptions** (prompt/tool definition, low
   effort): 44% of interior turns make a single call (V5).
8. **Record the test-verifier suite command, exit code, duration and failure
   signature; skip the suite for rounds that cannot affect it** (tool
   definition/engine, low effort) (V7).
9. **Retire `agents-verifier` from any remaining configuration** (config, trivial)
   (V10).
10. **Deduplicate and bound the empty-settle nudge** (engine, low effort) (V6).

### Telemetry to keep for verifiers, going forward

Per tool call: run id, role, round index, turn index, tool name, argument digest
(stable hash + bounded human digest: file path for read/grep, command head for
bash), result bytes/lines/truncated, ok + failure kind, duration.
Per run: role, step, model and pool, round index, attempt, whether the findings
artifact was written, finding count by severity, peak context tokens, compaction
events, wall time excluding host-suspended gaps.
Per round: the event in recommendation 1, plus the previous round's finding ids
so repeats ("found again, unchanged") can be distinguished from new findings.
Per finding: severity, path, line, a topic digest, and the disposition
(accepted/rejected) — the `developer_accepted_finding` event already exists.

### Measurement plan

1. Baseline on the current snapshot: verifier runs/turns/calls/cost per era,
   rounds per workflow, roles per round, cost per round, zero-yield share of
   instrumented rounds, cost share of turns above 100k context, calls per turn,
   failed calls per 100 calls, test-verifier suite seconds per round. The first
   six come from `analyze.ts verifier-rounds` plus the `verifier-findings` query.
2. After the round event exists, re-measure (a) rounds ≥2 cost as a share of
   round 1, (b) accepted findings per 1.00 cost, (c) turns per verifier run,
   (d) share of runs with zero successful tool calls.
3. Acceptance criteria: rounds ≥2 under 25% of round-1 cost with no fall in
   accepted findings per round; zero-successful-call runs under 2%; turns above
   100k context under 10% of slice cost; ≥1.0 calls per turn for review-only
   roles; every round carrying the new event.

## Open questions

- What exactly is an empty settle? No current code path emits the event, and the
  dataset stores no reason. If it means "settled without a findings artifact",
  the 121 events are direct evidence of empty verifier rounds beyond V2's count.
- Did the 25 empty instrumented rounds really find nothing, or did the generation
  drop empty results? The 17 workflows with empty settles agree with "nothing";
  the other workflows are unresolved.
- What does verifier work cost today? 32% of verifier turns carry no cost. Until
  the Sep/Oct generation records it, any "verifiers are 14% of spend" statement
  describes July and August only.
- How much of the 47% input-token share is the shared prompt prefix versus files
  the verifier actually read? Per-turn counters cannot separate them
  (`input_tokens` is 2 on trace-sourced turns; only `cache_read/write` is usable).
- Do 4-5 round verification loops still happen? The five-round examples are stubs
  in this snapshot, so the maximum observed here is three.
- Would a verifier detect more or less with a bounded context? Nothing in the
  data links a verifier's peak context to whether its round produced an accepted
  finding; that is a controlled experiment, not a query.
