# Efficiency deep dive 2e — wiki, archive and delivery

Scope: the tail of a workflow — the `wiki` role that drafts documentation, the
`archive` role that runs the OpenSpec lifecycle, and the delivery path
(`archive_started/completed`, `git_operations_*`, `workflow_closed`, the delivery
effects and their retries). Measured from the pinned dataset
(`dataset.sqlite`, preferred rows) plus the raw harness/telemetry stores where
the dataset has no rows, and read against the product's own step graph and
instructions. No transcript, tool-argument or tool-result text is reproduced
here; ids, counts and byte sizes only.

## Summary

The slice is small in tokens (**4.05 of 391.02 cost units, 1.0 %**; 1,320 of
33,137 turns, 4.0 %; 1,068 of 25,024 call rows, 4.3 %) and it is *nearly
invisible* in the newest round — no delivery event after 2026-08-14 and almost
no archive/wiki telemetry after 2026-08-31. What it does show is a mechanical
step that still runs a model, a wiki step that reads far more than it writes,
and a delivery path whose only recurring failure (SSH credentials) is retried
without changing anything.

| id | finding | measured impact | conf. |
| --- | --- | --- | --- |
| WD-1 | The archive is a model run for a 2-command job; the engine once did it deterministically | 78 runs / 721 turns / 350 recorded calls / **1.85 units**; 72 of 78 runs use ≤6 calls (487 turns, 163 calls, 1.79 units); the 2026-07-27..08-14 effect path archived 32 workflows in 9.7–35.2 s (mean 18.2 s) with **no tokens**, and no emitter for those events exists in the source today | high |
| WD-2 | The wiki agent spends most of its run before it writes anything | 320 of 489 `core.wiki` turns (65 %) and 1.28 of 1.94 units (66 %) precede the first write; in the 12 runs whose calls survive, 7 spend ≥95 % of their calls before the first write | high |
| WD-3 | The wiki agent reads through `bash` | 431 of 718 wiki calls are `bash` (60 %), carrying 1.36 MB of the 1.79 MB measured result bytes; one transcript spent 15 cat/sed + 11 rg + 8 git + 6 openspec calls around a single write | high |
| WD-4 | The archive failure path does not converge | 2 runs (110 and 58 turns) are 168 of 721 archive turns (23 %) and both ended `attention-required`; the 58-turn run issued ~40 openspec commands (90 kB of output) and still failed | high |
| WD-5 | `delivery.push` fails on SSH credentials and is retried unchanged | 6 `git_operations_failed` in 3 workflows, cause `git push` → `Permission denied (publickey)` (verified in raw telemetry); one workflow retried 3× in 23 s with nothing changed; the same failure reproduced on 2026-10-16 for 3 workflows, each listed **6×** as an identical failed-effect line inside one monitor note | high on cause+shape, medium on 10-16 attribution |
| WD-6 | The tail is the developer waiting, not the agents working | wiki-approval → next archive action mean 33.3 min (max 221.6, n=7); pushed → closed mean 5.2 min (max 44.0, 6 of 32 >5 min; 14 >1 min); review-ready → approved mean 19.9 min (max 160.6, n=32) — against 18.2 s of archive work and 2.5 s of push | high |
| WD-7 | A blocked wiki step is re-spawned twice for free | `find-all-wiki-entries-related-to-agent-spawning` spawned `wiki` 3×: a 49-turn run blocked, then two runs with 0 turns and 0 calls | high |

Cost decomposition of the slice: archive 1.849 units / 721 turns / 350 call rows;
wiki 2.201 units / 599 turns / 718 call rows. The wiki number is **85 % one
run** (`introdcude-pi-durable`, 114 turns, 188 calls, 1.865 units on
`claude-5-sonnet`); the median wiki run costs ≈0.03 units.

## Slice and method

**Definition.** `v_runs.role = 'archive'` (78 runs), `role = 'wiki'` (15 runs, 13
with turns), plus the delivery/gate event classes that surround them
(`delivery.*`, `git_operations_*`, `archive_*`, `workflow_closed`,
`developer_review_*`, `effect.result`, `developer.action` on `core.wiki*` /
`core.archive`). The `researcher`/`research-wiki` runs that wrote wiki are **not
in the dataset** (harness-only rows); the two raw conversations that carry them
were read directly instead of being re-measured here — see Data limits.

**Coverage of the slice.**

| role | runs | turns | call rows | cost | input | output | cache read |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archive | 78 | 721 | 350 | 1.849 | 312,710 | 115,317 | 4,810,800 |
| wiki | 15 (13 w/ turns) | 599 | 718 | 2.201 | 262,685 | 160,882 | 21,209,943 |
| corpus | 1,238 | 33,137 | 25,024 | 391.016 | — | — | — |

Argument digests exist for 109 wiki and 56 archive calls; result sizes for 275
wiki and 58 archive calls. So "repeated call" and byte accounting below are
**lower bounds**, and the per-run call counts of the 30 archive runs that record
no calls at all (mean 5.4 turns) are unknown.

**Method.**

1. Dataset queries: the existing helpers (`orientation-cost`, `calls-per-turn`,
   `effect-failures`, `repeated-reads`, `handoffs`) plus targeted SQL over
   `v_runs`, `v_turns`, `v_tool_calls`, `v_events`.
2. One new reusable query, `delivery-timeline` (append-only in
   `scripts/efficiency/lib/queries.ts`, with a test that injects synthetic
   delivery rows and asserts both the measured and the null latencies). It
   produces the numbers for WD-5, WD-6 and the wiki-approval gap.
3. Raw stores, because the dataset has no harness rows: three transcripts
   (`main-store/harness-stale-oct12.sqlite` conversations 2 and 2919 and 3112 —
   two wiki runs and one archive run; `wiki-workflows/harness.sqlite`
   conversation 2 and 463 — the two researcher runs) were normalised with
   `bun:sqlite` (`file:…?immutable=1`) into per-turn/per-call records with
   argument digests and result sizes, and classified by command family. Ran:
   **`wiki-64aaa6c9` (conv 2), `wiki-49ce52f0` (conv 2919), `archive-a06142e6`
   (conv 3112), `researcher-d2313121` (wiki-workflows conv 2),
   `researcher-0400054b` (conv 463)**; the run ids these belong to are
   `8127b909…`, `b8a5c3de…`, `2d124f84…`. This is the whole archive/wiki
   transcript population that survives anywhere in the snapshot.
4. The orchestrator harness (`orchestrator/harness.sqlite`, conversation 2,
   1,225 entries / 570 turns) for the delivery-failure episode: the monitor
   notes, their internal structure, and the cost of the turns that answer them.
5. The product source for *why*: `agentic-coding/src/workflow/steps/wiki.ts`,
   `…/steps/lifecycle.ts`, `…/effect-runner.ts`, `…/contracts/workflow.ts`, and
   the materialised briefs in `src/workflow/embedded.generated.ts`
   (`instructions/archive.md` 1,364 B, `instructions/wiki-openspec.md` 8,088 B,
   `instructions/workflow-agent-protocol.md` 17,537 B).

## Findings

| id | evidence | quantified | kind | conf. |
| --- | --- | --- | --- | --- |
| WD-1 | 78 archive runs; `delivery.archive_started/completed` 32 each, 2026-07-27T07:21 → 2026-08-14T08:41; `delivery-timeline` | 721 turns / 1.85 units; 72 runs ≤6 calls = 487 turns, 163 calls, 1.79 units; old effect path 9.7–35.2 s, mean 18.2 s, zero tokens | engine | high |
| WD-2 | `analyze.ts orientation-cost`, role `wiki`, step `core.wiki`: 9 runs, avg first-artifact turn 53.3 | 320/489 turns (65 %) and 1.28/1.94 units (66 %) before the first write | prompt | high |
| WD-3 | wiki call mix; transcript conv 2919 | `bash` 431/718 calls; 1,357,424 B of bash results vs 168,368 B of `read`; 15+11+8+6 inspection calls around 1 write | tool | high |
| WD-4 | runs `7833709c…` (110 turns/106 calls) and `2d124f84…` (58/56), both `attention-required` | 168 of 721 archive turns (23 %); conv 3112: ~40 openspec commands, 90 kB of openspec output, 2 failures, no convergence | prompt/engine | high |
| WD-5 | `git_operations_failed` ×6 in 3 workflows; raw `opimize-tui-spacing` telemetry; monitor notes 2006/2032/2042 | 1 workflow retried at +11 s and +12 s; the other twice, 4.5 min apart; 2026-10-16: 3 workflows × 6 identical failed-effect lines per note, 3,216 B of notes, 0.763 units of orchestrator turns to answer them | engine | high/medium |
| WD-6 | `delivery-timeline`; `developer_review_ready`→`approved` | wiki→archive 33.3 min mean (max 221.6); pushed→closed 5.2 min mean (max 44.0); review 19.9 min mean (max 160.6) | config | high |
| WD-7 | `v_runs` for `find-all-wiki-entries-related-to-agent-spawning` | 3 wiki runs for one step, 49 + 0 + 0 turns | engine | high |

### WD-1 — the archive is a model run for a step the engine can execute

The archive brief is explicit and short: `openspec validate "$HERDR_CHANGE_ID"
--strict`, `openspec archive "$HERDR_CHANGE_ID" --yes`, then one `git status
--short` and `openspec validate --all` — "run exactly these commands — no help or
discovery needed" (1,364 B). The runs do roughly that: `bash` is 264 of 350
archive call rows, and the runs that record calls average 7.3 calls / 11.7 turns
(48 runs), while the other 30 record no calls at all (mean 5.4 turns). The
distribution is bimodal: 72 runs at ≤6 calls (487 turns, 163 calls, 1.79 units),
1 at 7–12, and 5 above 12 (222 turns, 176 calls, 0.055 units).

The engine used to do this itself. In the window 2026-07-27 → 2026-08-14, 32
workflows carry a `delivery.archive_started` → `archive_completed` pair
immediately before `git_operations_started`: mean **18.2 s** (min 9.7, max 35.2),
no token usage attached to the step, and no wiki step in the same workflows
(0 of the 32 carry any `core.wiki` event). The current source contains no emitter
for those events — `delivery.commit` and `delivery.push` are the only delivery
effects left (`contracts/workflow.ts`, `effect-runner.ts`) and `core.archive` is
an agent step with `roles: () => ["archive"]` (`steps/lifecycle.ts`).

So the archive is ~7 turns and 1.8 cost units of model time for what an effect
did in 18 s, and the model is only *needed* on the failure path (WD-4). Note the
caution: the older window also has `archive`-role runs (with turns and cost), so
"engine effect" and "agent step" may have coexisted there; see Open questions.
That question is now settled — the pair bracketed the archive agent's own run and
there was never an engine effect; see
[`02i-archive-effect-counterfactual.md`](./02i-archive-effect-counterfactual.md).

### WD-2 / WD-3 — the wiki agent reads first and writes last

`orientation-cost` for role `wiki`, step `core.wiki`: 9 runs that produced an
artifact, average first-artifact turn **53.3**, with **320 of 489 turns** and
**1.28 of 1.94 units** before it. Per run (calls before the first write / total
calls, 12 runs whose calls survive): 107/132, 72/97, 65/68, 57/57, 54/54, 50/51,
43/43, 42/57, 34/46, 33/33, 27/27, 18/52 — seven of the twelve spend **≥95 %** of
their calls before writing anything.

The reads are mostly shell: wiki calls are `bash` 431 (60 %), `read` 200 (28 %),
`codemode` 56, `write` 25, `ask_jev` 4, `edit` 1 — and the bash results carry
1.36 MB against 168 kB for `read`. Transcript conv 2919 (`b8a5c3de…`, 38 turns /
57 calls) is the shape: 15 cat/sed/head, 11 rg/find, 8 git (52 kB of diff
output), 6 openspec, 3 `wiki show`, 2 `wiki search` — around **one** `wiki
write`. Conv 2 (`8127b909…`, the "find all wiki entries" task, blocked) is 45
bash calls of which 16 are rg/find, 13 git, 6 `wiki verify/log/list`.

This is not an accident of the model: the brief asks for it. `wiki-openspec.md`
(8,088 B) opens with "Discover before writing", requires searching "with
multiple related terms", inspecting "every plausible candidate with `wiki show`"
and comparing identifier, title, description, tags, body, scope, status, trust
tier, staleness and sources before choosing a write path. That is a sound
anti-duplicate control (keep it — see Justified), but it is stated as an
unbounded prior phase, and the runs behave accordingly.

### WD-4 — the archive repair loop does not converge

The brief allows structural repair ("add `## MODIFIED Requirements` … Never
change requirement or scenario content") and then a retry. In conv 3112
(`2d124f84…`, `add-definition-family-traits`) that became ~40 openspec
invocations, 90 kB of openspec output, two explicit failures, 58 turns and a
`blocked` handoff; `7833709c…` (`confidence-gating-removal`, model
`space-bunny-free`) spent 110 turns and 106 calls and also ended
`attention-required`. Together 168 of 721 archive turns (23 %) bought no
archive; both workflows needed an `operator.repair` to move at all.

### WD-5 — the credentials failure is retried unchanged, and the monitor repeats it

Six `git_operations_failed` events in three workflows. For
`opimize-tui-spacing` the raw telemetry carries the full error:
`git push --set-upstream origin feature/opimize-tui-spacing` →
`git@github.com: Permission denied (publickey)`; the dataset stored only the
error *length* (233 B) for that workflow and 160/241 B for the two grid-repo
workflows, all in the same 11-day window (2026-07-31 → 2026-08-14).
`change-validation-logic-for-power-threshhold` ran
`started → failed` three times at 09:00:34.854, 09:00:45.951 and 09:00:57.824 —
three attempts in 23 s, nothing changed between them;
`change-plausicheck-limits` did it twice, 4.5 min apart.

The 2026-10-16 round reproduces the same symptom for three more workflows
(`env-setup-staged-config-root`, `tui-mouse-navigation`,
`orchestrator-event-subscriptions`): their stores did not survive the snapshot,
but the orchestrator's monitor notes do. Three notes (10:35:21, 11:02:42,
11:03:46; 1,332 + 966 + 918 B) each contain exactly two distinct lines —
`→ core.delivery (attention required)` and `→ core.delivery (effect failed:
delivery.push)` — **repeated 6× each**, so one workflow id appears 12× inside a
note that carries a single failure. Answering those three notes cost the
orchestrator 0.107 + 0.435 + 0.221 = **0.763 units** across its next three turns
(one of them pulled a 53.7 kB result). The token cost is small next to the
orchestrator's total; the noise and the two-hour stall are the real cost.

### WD-6 — what the tail actually waits for

`delivery-timeline` (32 workflows with a push):

| segment | n | mean | max |
| --- | --- | --- | --- |
| `archive_started` → `archive_completed` | 32 | 18.2 s | 35.2 s |
| `git_operations_started` → `pushed` | 32 | 2.5 s | 7.1 s |
| `pushed` → `workflow_closed` | 32 | 5.2 min | 44.0 min (6 >5 min, 14 >1 min) |
| `core.wiki-approval` handoff → next archive action | 7 | 33.3 min | 221.6 min |
| `developer_review_ready` → `developer_review_approved` | 32 | 19.9 min | 160.6 min |

The agent-side work in this slice is seconds; the minutes and hours are the
developer approving, closing and pushing the button. No engine change is
proposed for it (a delivered workflow waiting for a human is not waste) — but
the *order* of steps is sound: `archive_started` precedes `git_operations_*` in
all 32 workflows, so the archive commit is inside the push, and the wiki step
runs after verification and before archive, so nothing documented is invalidated
afterwards. No `rebase` event and no `apply_base_moved` event exists in the
pinned dataset (the inventory lists one such row in its event table — see Data
limits 8), so there is no measured rework from the order of these steps.

## Justified (looked wasteful, is not)

* **`wiki search` / `wiki show` before writing.** 3–6 calls and 26–55 kB per run.
  This is the mechanism that stops duplicate concepts; the cost is trivial and
  the alternative (create-then-deduplicate) is worse.
* **`openspec validate` / `archive` in the archive step.** That is the job. The
  instruction's discovery ban is already explicit, and the archive brief is one
  of the *smallest* asset (1,364 B) — there is no prompt bloat to trim here.
* **A handful of `git` calls in a wiki run** (8 in conv 2919, 52 kB): reading the
  diff of the change being documented is the only way to cite it.
* **The one long wiki run.** `introdcude-pi-durable` (114 turns, 188 calls,
  1.865 units, `claude-5-sonnet`) is 85 % of the wiki slice's cost and the
  reason its mean looks high; documenting a runtime rewrite is a real
  documentation job, and the per-run median (≈0.03 units) is the number to
  optimise against.
* **`effect.result` volume.** 2,469 rows corpus-wide (74 workflows with >5) and
  8–12 per slice workflow: normal bookkeeping, not noise. Only the *digest* of a
  failure is noisy (WD-5).
* **The monitor notes themselves.** 86 notes, 17.3 kB total (mean 201 B). The
  cost of the turns they wake is the cold prompt cache (see 02h ORCH-1), not the
  note.
* **`workflow_closed` arriving late.** It is a developer action; measuring it as
  engine latency would be wrong.
* **No archive repetition.** Each of the 78 workflows archived exactly once — no
  re-archive, no rework after the wiki.

## Data limits

1. **The dataset has no harness rows at all, so the inventory's slice numbers
   are not reproducible.** Every `harness.sqlite` is a WAL database without its
   `-shm` file and the reader opens it read-only, so 0 of 9 parsed (02h reports
   the same defect). Consequences here: `docs/efficiency/00-data-inventory.md`
   lists wiki at 17 runs / 687 turns / 827 calls and archive at 79 / 774 / 404,
   while the dataset has wiki 15 runs (13 with turns) / 599 turns / 718 call
   rows and archive 78 / 721 / 350; `role = 'researcher'` does not exist in the
   dataset at all. Everything above is therefore a **lower bound**, and the
   researcher half of the slice was measured from the raw store instead.
2. **Two counters disagree.** `v_turns.tool_calls` sums to 399 (archive) and 917
   (wiki), against 350 and 718 `v_tool_calls` rows. I used the row counts for
   call statistics and said so.
3. **Arguments and result sizes are mostly absent.** 109 wiki and 56 archive
   calls carry an argument digest; 275 wiki and 58 archive calls carry a result
   size. Exact-repeat detection is possible only for those; `repeated-reads` and
   `repeated-calls` find **nothing** in the slice for that reason, not because
   the calls are distinct.
4. **Wiki page bodies are not in the evidence.** Page count, page size, facts
   per page, rewrite-vs-patch and cost per changed fact cannot be measured. The
   only proxies are the write argument bytes: 39 archive writes at 4,932 B mean,
   and three wiki runs with measured write arguments at 5.5–6.9 kB per write
   (27,596 B / 5 writes, 34,697 B / 5, 18,112 B / 3).
5. **The newest round is mostly gone.** No `git_operations_*` or `archive_*`
   event exists after 2026-08-14; the 2026-10-14..16 worktrees kept telemetry
   files with a single `workflow.started` line each, so the freshest wiki runs
   (7 in 2026-10, cost recorded for 1) and archive runs (2 in 2026-10) are
   stubs. The 2026-10-16 delivery retries are visible **only** as the three
   monitor notes; the failed-effect rows themselves are in stores the snapshot
   excludes. That is the whole delivery slice's blind spot: ~5 weeks, 0 events.
6. **`pushed → closed` is human latency**, and `wiki-approval → archive` mixes
   the developer reading a draft with whatever else they were doing.
7. **Reported discrepancy (tooling).** At HEAD,
   `test/efficiency/efficiency-queries.test.ts` was merge-damaged: the
   `cache-expiry` test was spliced into the `orientation-cost` test (and the
   `verifier-rounds` test into `edit-latency`/`stalled-runs`), so the file did
   not even parse — `bun test` on the HEAD version reports `0 pass, 1 error`
   ("Unexpected finally"). Every query assertion added by 02b/02c/02d/02h was
   therefore unexercised in the merged tree. It is repaired here (see
   Artefacts); with the repair, 52 tests pass.
8. Minor: the brief's "about 79 archive runs, 774 turns" / "17 wiki runs, 687
   turns" are the inventory's (harness-inclusive) figures; the dataset numbers
   are WD-1's. The inventory's event table also lists an `apply_base_moved` row
   (`other`, 1 occurrence) that the dataset does not carry at all, preferred or
   not — one more hint that the two were built from slightly different reads.

## Recommendations, ranked by expected saving per effort

| rank | recommendation | kind | expected saving | effort | how to verify |
| --- | --- | --- | --- | --- | --- |
| 1 | Run the archive happy path in the engine again: `openspec validate --strict` + `openspec archive --yes` (+ `validate --all`) as a `delivery` effect, and spawn the `archive` role only when the command fails | engine | ~1.8 of 1.85 units and ~487 of 721 archive turns for the 72 runs at ≤6 calls; the old effect path did it in 18.2 s mean | medium | `analyze.ts delivery-timeline` + archive turns/cost per workflow in the next snapshot should collapse to ~0 for passing archives; compare effect wall time with 18.2 s |
| 2 | Bound the archive repair loop: at most 2 validate/archive attempts, then `blocked` with the validator output | prompt/engine | caps the 168-turn (23 %) failure tail at ~10 turns | low | archive runs with >12 calls per snapshot; the two runs above are the regression fixture |
| 3 | Make the wiki brief write-first: name the change delta and plan in the assignment, require exactly one search per target concept, and make "inspect every plausible candidate" apply only when create-vs-update is genuinely open | prompt + task shape | the 65 % orientation turn share is the target; a fall to ≤30 % is ~300 turns of the slice's 489 `core.wiki` turns | low | `analyze.ts orientation-cost` for role `wiki` (`turns_before`, `cost_share_before`) |
| 4 | Give the wiki role a scoped read primitive (change delta, concept-by-id) and cap discovery (e.g. 12 calls) before the first write | tool definition | the 431 bash calls / 1.36 MB of bash output are the bulk of wiki reading | medium | wiki call mix per tool and result bytes; cap violations counted as a lint |
| 5 | Preflight push credentials before `delivery.push` (non-interactive dry-run / SSH check) and on auth failure block **once** with an actionable note instead of retrying unchanged | engine | removes the 3-attempts-in-23 s storm and the 6× duplication; the 2026-10-16 episode would have been one message, not a 2 h stall with 3 notes | low | `delivery-timeline.git_failures` and the failed-attempt count per effect; monitor notes per failed effect |
| 6 | Deduplicate the monitor digest: one line per (workflow, step, effect) with an attempt count | engine | the 3 storm notes (3,216 B, 12 id mentions each) become 3 lines; less for the orchestrator to re-read | low | note bytes and distinct lines per note, counted as in this report's method |
| 7 | Do not re-spawn a blocked step without changed input: the third-to-first wiki run here produced 0 turns and 0 calls | engine | 2 wasted `agent.launch` effects per blocked wiki step | low | `stalled-runs` query limited to `role='wiki'`; the 3-run workflow is the fixture |
| 8 | Keep developer waits out of any "agent time" metric; report `pushed → closed` and `wiki-approval → archive` as human latency | config/reporting | no direct saving; prevents the wrong conclusion from a 44 min "delivery" | low | the two gaps in `delivery-timeline` |

## Open questions

* **Was `delivery.archive_started/completed` really an engine effect doing the
  same work?** **Settled: no.** The git history the spike was allowed to read
  shows both events emitted around the archive agent's own run; see
  [`02i-archive-effect-counterfactual.md`](./02i-archive-effect-counterfactual.md).
* **Why do wiki runs stop after 2026-10-07?** 7 runs in October but cost recorded
  for one, and none after. Reduced use, a different workflow family, or lost
  telemetry — the snapshot cannot tell.
* **What does a wiki run produce?** Concepts per run, page sizes and
  rewrite-vs-patch are unmeasurable without the page bodies; "cost per changed
  fact" therefore has no denominator.
* **Who started the third wiki run** for
  `find-all-wiki-entries-related-to-agent-spawning` — the engine's retry policy
  or the developer? Both runs have 0 turns, so only the launch record (not in the
  snapshot) would say.
* **Is the 2026-10-16 push failure the same SSH cause?** Same symptom, same
  three-workflow shape, but their stores are gone and the notes carry no error
  text, so the cause is inferred by analogy, not measured.
* **Do these proportions hold for the other families?** The slice is dominated
  by two repositories (agentic-coding and the grid repository) and by one
  October run; the wiki orientation share is a 9-run average over a step used
  rarely.

## Artefacts and reproducibility

* New query `delivery-timeline` in
  `agentic-coding/scripts/efficiency/lib/queries.ts` (append-only): per
  workflow, the archive/push latencies, the pushed→closed and
  wiki-approval→archive gaps, the archive/wiki run counts and the
  effect/git-failure counts. Run it with
  `bun run scripts/efficiency/analyze.ts delivery-timeline --dataset <dir>`
  (it reads `v_events` and `v_runs` only).
* Test `delivery-timeline measures the latencies it has and leaves the rest
  null` in `agentic-coding/test/efficiency/efficiency-queries.test.ts`: it copies
  the fixture dataset, inserts synthetic delivery/handoff/developer-action rows
  and asserts both the measured values (20 s archive, 3 s push, 10 min to close,
  60 min wiki-approval→archive) and the nulls for a workflow that only failed.
* Repair of the merge-damaged test file described in Data limits 7 (no query
  behaviour changed; the four tests are restored to the assertions their own
  queries define).
* The transcript analysis used scratch scripts outside the repository; nothing
  from the stores was committed. The command families, counts and byte totals
  quoted above are reproducible from the raw stores with `file:…?immutable=1`
  and a per-entry normaliser.
