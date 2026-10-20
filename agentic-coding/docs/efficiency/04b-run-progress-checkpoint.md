# Addendum — the run-progress checkpoint, measured before it ships

Backlog item 19 (`04-backlog.md`) proposed a turn/context ceiling that stops a
run and hands off `blocked`. That proposal is rejected: a raw turn count never
stops or blocks a run. What ships instead is a **checkpoint** — a per-run
supervisor in the durable agent host that evaluates a soft threshold plus
objective stall signals, records a decision over a fixed vocabulary
(`continue`, `steer`, `compact`, `switch-model`, `escalate`), and can only reach
a stop through a normal developer question that the developer cancels or leaves
pending. Every failure path ends in `continue`.

This addendum is the measurement the shipped defaults are pinned from, and the
record of what the rules would have done to the runs already on disk. It is
additive: `00`…`04` keep their figures.

## The denominator this is measured against

`04a-harness-reader-repair.md` repaired the denominator. The same repaired
numbers are the baseline here, rebuilt from the read-only snapshot into a
temporary directory (`build-dataset.ts --evidence
~/agentic-coding-efficiency-evidence/latest --out $(mktemp -d)`, the evidence
tree never written to):

| workflows | runs | turns | tool calls | events | cost units |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 668 | 1,259 | 34,711 | 26,847 | 7,838 | 441.9321 |

Two properties of this dataset matter for everything below and are stated
rather than assumed:

- Only **944 of 1,259 runs have turn rows** (the rest are reconstructed from
  events or traces without a per-turn span), and only **73 of those 944 carry a
  known outcome** (handoff `complete`, or run status `complete`/`completed`).
  Every "successful" column is therefore a sample of 3–42 runs.
- Only **3,120 of 26,847 calls (11.6 %) carry an argument hash**, and only **27
  of 944 runs carry one at all**. The exact-repeats signal is blind on
  historical data wherever the hash is missing; on a live run the host hashes
  the call's arguments itself, so this is a limitation of the recorded past, not
  of the checkpoint.

## The turn distribution (the measurement)

`analyze.ts turn-distribution` — nearest-rank percentiles over every run with
turns, and over the successful subset:

| class | runs | p50 | p90 | p95 | p99 | max | successful n | successful p50 | p90 | p99 | max | known outcome |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| worker | 117 | 77 | 271 | 377 | 1,010 | 1,072 | 14 | 172 | 886 | 1,010 | 1,010 | 67 |
| planner | 212 | 15 | 56 | 69 | 95 | 166 | 3 | 122 | 166 | 166 | 166 | 41 |
| verifier | 383 | 16 | 65 | 92 | 194 | 228 | 42 | 67 | 186 | 228 | 228 | 179 |
| mechanical | 218 | 6 | 30 | 40 | 114 | 188 | 14 | 28 | 82 | 114 | 114 | 108 |
| other | 14 | 62 | 110 | 570 | 570 | 570 | 0 | — | — | — | — | 3 |

Two facts drive the design and are visible in this table. Successful worker runs
reach **704, 886 and 1,010 turns** at 0.27–0.70 cost units each, so a turn count
is neither a cost nor a failure signal; and the expensive outlier (66.4 units,
1,072 turns) is *under* every limit above the successful p99, so no turn limit
would catch it. What distinguishes it is lack of progress while cost per turn
rises.

## The pinned thresholds (task 1.2)

Formula, applied to the table above:

- `softTurns` = the class p90, rounded **up** to 10;
- `hardTurns` = `max(5 × soft, 1.2 × successful p99, 1.2 × all-runs p99)`,
  rounded **up** to 50;
- checkpoint interval after the first checkpoint = `max(10, soft / 2)`;
- `contextTokens` = 200,000 for every class (above the shipped 150,000
  compaction ceiling, so it fires only when ceiling compaction did not hold the
  context).

| class | p90 | all-runs p99 | successful p99 | softTurns | hardTurns | interval | hard vs successful p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| worker (and `other`) | 271 | 1,010 | 1,010 | **280** | **1,400** | 140 | 1,400 > 1,010 |
| planner | 56 | 95 | 166 | **60** | **300** | 30 | 300 > 166 |
| verifier | 65 | 194 | 228 | **70** | **350** | 35 | 350 > 228 |
| mechanical | 30 | 114 | 114 | **30** | **150** | 15 | 150 > 114 |

The formula moved one value against the planning table in `design.md`:

- **worker soft 250 → 280.** The planning measurement's worker p90 was 242; the
  rebuilt dataset's nearest-rank p90 is 271, which rounds to 280.
- **mechanical hard 150 stays 150.** The planning measurement had a mechanical
  p99 of 110 and the rebuilt dataset's is 114, so `max(5 × 30, 1.2 × 114,
  1.2 × 114)` = 150 — the `5 × soft` term binds. (The 188 in the distribution
  is the all-runs *maximum*, not its p99, so it does not enter the formula.) The
  hard limit also takes the all-runs p99 because the successful samples are tiny
  (planner n = 3).

`other` uses the worker row (an undeclared run is usually a worker), and its own
14-run distribution (p90 110, p99/max 570) is too small and too bimodal to pin
anything from.

The thresholds live in one place with a test that keeps the two copies equal:
`DEFAULT_CHECKPOINT_THRESHOLDS` in `src/agent-host/progress-checkpoint.ts` is the
host's value, `CHECKPOINT_THRESHOLDS` in `scripts/efficiency/lib/queries.ts` is
the SQL's, and `test/agent-host-progress-checkpoint.test.ts` fails if they
differ. An operator can override the soft/hard pair per class in
`[agents.checkpoint.<class>]`; the shipped values are the ones above.

## What the rules would have done to the recorded runs

`scripts/efficiency/replay-checkpoint.ts` feeds each recorded run's turns and
calls, in order, through the same pure module the host uses, and prints the
decisions `rules/v1` would have taken. It stops a run at its first escalation,
because the host parks a run only after the developer cancels or ignores that
question.

All 944 runs with turns, replayed (`--limit 100000 --json`):

| runs replayed | successful | runs with ≥1 checkpoint | checkpoints | continue | steer | escalate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 944 | 73 | 171 | 263 | 138 | 104 | 21 |

Decisions by rule:

| rule | decision | count |
| --- | --- | ---: |
| `default` | continue | 138 |
| `no-progress` | steer (`make-the-change` / `conclude`) | 96 |
| `steer-ignored` | escalate | 15 |
| `cost-rising` | steer (`converge`) | 8 |
| `no-progress-twice` | escalate | 6 |

Escalations by class and outcome:

| class | runs | checkpoints | escalations | of which runs that still completed | of which blocked/failed | of which outcome unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| worker | 117 | 99 | 7 | 4 | 1 | 2 |
| planner | 212 | 42 | 7 | 0 | 0 | 7 |
| verifier | 383 | 81 | 0 | 0 | 0 | 0 |
| mechanical | 218 | 31 | 6 | 0 | 1 | 5 |
| other | 14 | 10 | 1 | 0 | 0 | 1 |

How to read this:

- **21 escalations over 944 runs (2.2 %)**, 12 % of the 171 runs that got a
  checkpoint. Four of the 73 successful runs would have seen one developer
  question; answering it `continue` costs one question and no lifecycle change.
- **The counter is an upper bound.** The replay cannot let a steer change the
  run's behaviour, so every `steer-ignored` escalation assumes the nudge was
  ignored. A real steer that produces the edit ends the signal. The 15
  `steer-ignored` decisions are the most pessimistic number in this table.
- **Verifier runs escalate zero times** once a read-only run's progress is
  counted correctly: a call without an argument hash is treated as *new* in a
  read-only run, so missing hashes cannot manufacture a stall. (With the naive
  "no hash ⇒ no progress" rule the same replay produced 26 verifier
  escalations — a false-alarm generator, which is why the fail-open choice is
  the rule and the unit test pins it.)
- **`no-progress` dominates the steers (96 of 104)**, almost all at the first
  stall turn (40) on runs that spend their first 40 turns reading before the
  first write. The nudge is one line from a closed catalog and is submitted at a
  turn boundary; it does not touch a tool call in flight.
- **The repeats signal never fires in this replay** and would be blind even if
  the runs were steered: only 27 of 944 runs carry any argument hash. That is a
  recorded-data limit, not a rule limit — the live host hashes every call.
- **Tick-task, diff and `HEAD` progress are unknown offline.** The replay
  therefore counts only successful `edit`/`write` calls and, for a read-only
  run, new calls. A live run also gets progress from a changed
  `git diff --shortstat`, a new commit and a ticked task, so the live escalation
  rate should be lower than the replay's.

The four long successful worker runs, replayed decision by decision:

| run | turns | outcome | decisions |
| --- | ---: | --- | --- |
| `e06de610…` | 1,072 | blocked | 40 steer/no-progress, 180/320/460/600/740 continue/default, 880 escalate/steer-ignored |
| `57042d10…` | 1,010 | complete | 40 steer/no-progress, then continue/default every 140 turns |
| `14639bc1…` | 886 | complete | 40 steer/no-progress, then continue/default every 140 turns |
| `5e878ae3…` | 704 | complete | 40 steer/no-progress, 180 escalate/steer-ignored |

The 1,072-turn outlier is caught by a stall, not by a limit — which is the
design's claim, verified rather than asserted. The two `steer-ignored`
escalations on runs that completed cheaply are the false alarms the developer
would have been asked about; both are within the 140-turn window after a steer,
which is exactly what "a nudge did not change anything for another interval"
means.

The other headline (from `analyze.ts run-progress`) is the cost shape the
checkpoint is aimed at: the 1,072-turn run spends 23.1648 units in its first
half and 43.2166 in its second (ratio **1.87**) at a peak context of 911,259
tokens; the 704-turn success has a second-half/first-half ratio of **5.72** but
at 0.27 units total. Cost per turn rising is only a stall signal *with* zero
progress in the window, which is why the cheap successes are never escalated for
it.

## The alarm and the queries

Four queries in `scripts/efficiency/lib/queries.ts` verify the targets:

- `turn-distribution` — the table above; the measurement the defaults are pinned
  from.
- `run-progress` — per run: class, turns, cost, peak context, second-half /
  first-half cost ratio, outcome, and whether the run passed its soft or hard
  threshold.
- `progress-checkpoints` — decisions by class × decision × rule, escalations per
  100 runs, filing failures, steers and steers after which progress followed, plus
  `errored` / `errored_runs` so a rule that always fails open is visible instead
  of looking like a healthy decision row.
  It returns **0 rows** on this dataset: no checkpoint has ever been recorded,
  which is the correct baseline before the feature ships.
- `checkpoint-gaps` — **the alarm**: runs that passed their soft threshold with
  no `runtime.checkpoint` envelope, or with only `status: "error"`. On this
  pre-feature dataset it lists **85 runs** (11 worker, 33 verifier, 22
  mechanical, 18 planner, 1 other) — every one of them expected, since the
  feature did not exist. Zero runs are above their hard limit. After the
  feature ships this query is the fail-open detector: a run above its soft
  threshold with no checkpoint means the host's evaluation is not running.

## The shipped defaults

`[agents.checkpoint]` defaults, decided from the numbers above:

| key | default | why |
| --- | --- | --- |
| `enabled` | **`true`** | The evaluation is cheap (one digest per checkpoint, ≤ 12 records per run) and cannot stop a run on its own. The replay's escalation rate is 2.2 % of runs and 4 of 73 successful runs; a false question answered `continue` costs one question. |
| `steer` | **`true`** | Without it every stall goes straight to a developer question; with it, 104 of 125 steer opportunities in the replay cost the run one line of text. The catalog is closed and versioned. |
| `contextTokens` | **200,000** | Above the 150,000 compaction ceiling, so it fires only when ceiling compaction did not hold the context — and it compacts, it does not escalate. |
| per-class `softTurns` / `hardTurns` | table above | The D3 formula, pinned by task 1. |

`enabled = false` is the whole rollback: no evaluation, no envelopes, no
records, no questions. Stored workflows without checkpoint records read exactly
as before, because there is no store schema change.

## What this does not prove

- **The successful samples are small** (3–42 runs per class). The hard limit is
  placed above both the successful p99 and 1.2 × the all-runs p99 to compensate,
  but "no successful run has ever needed more than this" is a weak statement at
  n = 3 for planners.
- **The replay cannot measure the effect of a steer.** The only honest claim is
  the negative one: no replayed turn count stopped anything, and the only stops
  in the design are the developer's own answer to a question.
- **`switch-model` is unmeasured** because nothing selects it: it is vocabulary
  in this release, recorded `applied: false`.
- **The cost-rising ratio is a coarse instrument.** It compares the last
  interval with the run's first half; the 704-turn run shows 5.72 and never
  escalates because it keeps making progress.
