# Efficiency deep dive 2d — triage, gates, routing and engine overhead

This is a **report only**: nothing under `src/`, `packages/` or
`agent-definitions/` changed for it. Training data is the pinned normalized
dataset (`dataset.sqlite`, built 2026-10-16T12:35:27Z) and the raw snapshot it
came from; the live stores were never opened. Costs are dataset "units"
(`v_turns.cost` summed), not currency.

## Summary

| id | finding | quantified impact | confidence |
| --- | --- | --- | --- |
| X1 | 02c's V3 — "57 verifier runs had every recorded tool call fail" — is a **recording artifact**, not behaviour | withdraws 15.05 units (3.8% of the dataset's 391.0) and 2,492 turns from the waste column; the corrected count in an era that records successes is **0** | high |
| T6 | 42 manual re-entries (`operator.repair`) across 23 workflows | those 23 workflows carry 124.64 of 391.0 units (31.9%); mean 5.42 units/workflow vs 1.16 for the other 230 | high (numbers), medium (attribution) |
| T2 | the current engine records **no** triage decision: which roles and files a round will verify is unobservable after 2026-08-14 | 1,584 `triage_*` events all end 2026-08-14T08:37Z; `verifier_dispatched`/`verification_started` end with them | high |
| T1 | triage narrowed 8 candidate roles to 1–3 (median 2) and the narrowing was honoured exactly — but only at file granularity | triage cost 5.39 units = 9.0% of the cost and 13.0% of the turns of the verification it gates; 160 of 204 file selections carry no hunk, all 142 hunk rows carry hunk index 0 | high (counts), medium (value) |
| T8 | human waits are the largest single time sink in the slice | 22 question waits = 3,562 s (median 112 s, max 740 s); 18 blocked handoffs in 12 workflows (all Sep/Oct); 48 inter-run gaps of 10–60 min and 15 over 1 h | high (counts), medium (share) |
| T3 | of ~16 recorded gate evaluations only the wiki gate ever decided anything | 4 `gate.skip`, all `core.wiki-gate`, all 2026-09-28/29; plan and review gates 0 skips in 13 evaluations, and a gate that answers `run` emits no event at all | medium (small n) |
| T4 | the routing classifier is free, fast and (so far) constant | 16 passes in 8 workflows: median 1,446 ms, 12/16 the same `cheap-medium-intelligence` pool, confidence 0.0003–0.289, fallback count 0 in all 16 | high (n=16), low (outcome effect) |
| T5 | engine failures are rare but concentrated in configuration plumbing | 21 effect errors of 2,469 (0.85%); 8 retried effects, all `workspace.setup`, up to 4 attempts; classes (deduped): name > 40 chars 7, worktree identity 3, worktree name mismatch 2, branch already checked out 2, settings adoption 3, env-setup guard 2, assignment > 96 KiB 2 | high (counts), low (cause) |
| T7 | the `global_search_blocked` guard fired on exactly the expensive search class — and then never again | 9 blocks in 6 workflows (2026-08-03…12), 3 of them a whole-filesystem `find`; zero in Sep/Oct despite ~5,100 October tool spans | medium |

The ordering rule is estimated cost or time recovered per unit of effort, and
X1 first because it is the only finding that removes a number other reports are
leaning on.

**X1 in one paragraph.** 02c reported 57 verifier runs (2,492 turns, 15.04
units, "27% of the slice") in which *every* recorded tool call failed, and
concluded the engine does not cut such runs short. The dataset reproduces that
set exactly — and every one of the 57 sits in July or August 2026, in the two
generations that recorded **only** failures: 25 runs from `telemetry.main-store`
(July) + 2 (August), 17 from `traces.otel-tui` (July) + 13 (August). In that
window the dataset holds 938 call rows and 938 of them are failures (100%),
against 2.4% in Sep/Oct. Checked at the source: the 15 legacy telemetry files
contain `tool_error` and no successful-call record at all (the largest carries
535 `model_usage`, 533 `provider_response`, 56 `tool_error`, 0 tool-success
events), and the span store for the exact changes 02c names holds only
`tool_error` spans (`sanety-check-workflow-steps` 35/0, `change-substation-schema-to-not-include-capacity`
26/0, `add-comment-count` 25/0, `unify-scoring-rounding-to-two-decimal-places`
25/0, `make-ranked-endpoint-default` 20/0, `sorting-and-filtering` 19/0,
`adjust-ee-co-location-structure` 17/0, `fix-asset-links` 15/0 — while 19 *other*
August changes do have `runtime.tool` spans). Restricted to runs that started
on or after 2026-09-01, the count of verifier runs with ≥3 calls and all of them
failed is **0**. V3 must be withdrawn and its 15.04 units returned to the
"not waste, not evidence" column. The same trap inflates the sibling reports:
02b's 918 failed calls include 372 (40.6%) July/August worker rows from the
failure-only window — the honest post-August worker failure rate is 544/9,455 =
5.8%, not 9.3%, and failed edits are 191/1,560 = 12.2%, not 17.6%; 02a's
planner rate of 7.0% (157/2,248) includes 123 July/August rows, of which 123/123
are "failed" by construction — post-August it is 39/3,668 = 1.1%. 02a's F7
already states this effect for its synthetic rows, so only its rate line and
02b's W6 need the correction; 02c's V7 and V8 inherit the same inflation. V10
(`agents-verifier` is dead) survives on usage — its last run is 2026-08-05 —
but its "31/31 calls failed" is the same artifact.

## Slice and method

### Slice

From the pinned dataset (`v_*` preferred rows):

- **role `triage`**: 129 runs, 1,398 turns, 727 calls, 6.18 units, first
  2026-07-17, last 2026-10-14. (`recovery` 1 run, `git` 3 runs: too few to
  analyse; noted only.)
- **triage events**: 1,584 rows (`triage_file_selected` 923,
  `triage_hunk_selected` 329, `triage_role_selected` 104, `triage_role_suggested`
  98, `triage_started` 69, `triage_plan_selected` 61) over 37 workflows, all
  between 2026-07-24T06:50:08Z and 2026-08-14T08:37:20Z. The assignment's
  "869 triage_file_selected" is 923 in this dataset; see Data limits.
- **routing**: 32 `routing.classified` rows (16 distinct passes in the raw
  telemetry, 8 workflows, 2026-09-28 … 2026-10-16) plus 42 `model_selected`
  and 5 `runtime.model_selected` rows, all July/August.
- **gates and phases**: 491 `phase_changed`, 163 `developer.action`, 65
  `workflow_phase_overridden`, 47 `plan_quality_passed`, 5 `plan_quality_rejected`,
  44 `developer.question.created`, 37 answered, 1 expired, 41
  `developer_review_ready`, 38 approved, 4 `gate.skip`.
- **engine**: 2,469 `effect.result`, 42 `operator.repair` (23 workflows),
  22 `agent_launch_failed` (9 workflows, all 2026-08-03…06), 41
  `agent.assignment.delivered`, 9 `global_search_blocked`, 7
  `prompt_wait_timeout`, 8 `verification_timeout`, 2 `verifier_timeout`, 34
  `workflow_closed`/`archive_*`/`git_operations_*` delivery rows.

Baseline for shares: the dataset's 1,238 runs carry 391.0 units (July/August
314.85 over 955 runs, Sep/Oct 76.16 over 283 runs) and 33,537 turns.

### Method

Read with `sqlite3 -readonly` over the pinned dataset, with the repository's
`analyze.ts` queries plus the two added here (`source-recording`,
`triage-economics`, commit `22861df`), and directly against the snapshot's raw
telemetry (171 JSONL files: 153 under `main-store/telemetry`, 16 per-worktree
files, plus `backend/`, `orchestrator/`, `wiki-workflows/`) and the span store
`otel-tui/traces.sqlite`. The raw read was necessary twice over: the dataset
drops the span `command` attribute (the only record of *what* the global-search
guard blocked) and carries no payload for the gate/triage classifier passes.

Workflows read closely (by id, as the report does not reproduce content):
`opimize-tui-spacing`, `remove-unused-features`, `consolidate-workflow-to-typescript`,
`dashboard-in-process-engine`, `workflow-tui-cleanups`, `improve-user-actions-ui`,
`architecture-checkup-round-1`, `fix-pushing-changes-phase`,
`introduce-usability-verifier`, `add-logbook-logging`, `improve-logging`
(triage era); `add-definition-family-traits`, `propose-orchestrator-model-selection`,
`confidence-gating-removal`, `findings-dont-render-as-markdown-yet`,
`fix-verifier-findings-in-agent-panel`,
`introduce-local-model-support-for-classification`, `c42b6d2c-08c3-45f5-a6ef-3a251eb4afe3`,
`env-setup-grid-allocation-backend`, `48fac845-baec-46f7-a4c4-d692f95cad15`,
`introdcude-pi-durable` (current engine); `sanety-check-workflow-steps`,
`add-developer-review-ui`, `change-substation-schema-to-not-include-capacity`,
`fix-git-operations-and-workspace-closing`, `add-comment-count`,
`sorting-and-filtering`, `unify-scoring-rounding-to-two-decimal-places`,
`make-ranked-endpoint-default`, `adjust-ee-co-location-structure` (the X1 check).

### Assumptions

- Cost is only recorded where the source recorded it: September/October
  verifier runs show 3,576 turns for 0.83 units, so an era-over-era cost
  comparison is only meaningful next to the turn count. Where cost is thin I
  rank by turns.
- A `telemetry.main-store` "run" in July/August is the dataset's synthetic
  per-(workflow, role) row, not one attempt: several real runs of a role are
  aggregated into it (this is why one row can show 194 turns). Anything derived
  per row there is a per-role aggregate, including the X1 set.
- The private-subscription preset's gate policies live in the user
  configuration, which this review may not read (see Data limits), so policy is
  inferred from observed decisions rather than from the file.

## Findings

### X1 — 02c's V3 is a recording artifact (correction, no waste)

**Evidence.** Reproduced exactly from the dataset: verifier roles, ≥3 recorded
calls, every one failed → 57 runs, 2,492 turns, 15.05 units — matching 02c to
the second decimal. Split by month and source: 2026-07 `telemetry.main-store`
25 runs/1,425 turns, 2026-07 `traces.otel-tui` 17/642, 2026-08
`traces.otel-tui` 13/319, 2026-08 `telemetry.main-store` 2/106.

Three independent checks say the recording, not the agents:

1. Raw JSONL: of 153 `main-store/telemetry` files, 15 are the legacy envelope;
   they contain `tool_error` records and **no** successful-call records (one
   file: 535 `model_usage`, 533 `provider_response`, 56 `tool_error`, 0
   `runtime.tool`).
2. Raw spans: the span store records successful calls as `runtime.tool` spans.
   For every change 02c names, that change's spans contain `tool_error` only
   (`sanety-check-workflow-steps` 35/0, `change-substation-schema-to-not-include-capacity`
   26/0, `add-comment-count` 25/0, `unify-scoring-rounding-to-two-decimal-places`
   25/0, `make-ranked-endpoint-default` 20/0, `sorting-and-filtering` 19/0,
   `adjust-ee-co-location-structure` 17/0, `fix-asset-links` 15/0) — while 19
   other August changes do have `runtime.tool` spans.
3. Dataset-wide: July/August call rows are 938/938 failed (100%); Sep/Oct are
   229/9,500 (2.4%); the newest generation (no date on the row) is 763/14,586
   (5.2%). Restricting the X1 set to runs starting 2026-09-01 leaves **0 runs**.

**Impact.** 15.05 units (3.8% of the dataset's 391.0 units) and 2,492 turns were
booked as verifier waste that never happened; the derived statements ("13% of
verifier runs", "no retry visible", "dead tool surface") lose their footing.
Corrected sibling numbers: 02b W6 workers 5.8% (not 9.3%) and failed edits 12.2%
(not 17.6%); 02a F9 planners 1.1% (not 7.0%); 02c V8's 8.2% is a mix of eras.
All 14 `agents-verifier` runs are July/August, so V10's failure counts are
artifact but its "nobody uses this role any more" conclusion stands (last run
2026-08-05).

**Confidence.** High. Three sources agree; the 19 counter-example changes show
the store *could* record successes in the same month; and the corrected count is
a hard zero rather than a smaller number.

**Recommendation (tooling).** Never compute a failure rate over a mixed
generation. `source-recording` (added here) is the query for it; the dataset
could additionally flag a row whose source+month recorded no success at all.

**Verification.** Recompute V3's set restricted to eras with a recorded success;
accept a change to the report only if it reports that split.

### T6 — 42 manual re-entries, on the most expensive cohort of the dataset

**Evidence.** 42 `operator.repair` rows across 23 workflows. The reducer is the
CLI/TUI path (`workflow repair --workflow-id --revision --step` and the
dashboard's repair action): it expires the workflow's open effects and the
current run, re-enters the target step with a fresh attempt and clears
attention, so the step's in-flight work is discarded. Concentrations:
`48fac845-baec-46f7-a4c4-d692f95cad15` 10 repairs (core.triage,
core.implementation, core.verification, core.developer-review,
2026-08-31T13:41…15:30), `introdcude-pi-durable` 4, `e24d379f-…-83a3576` 3, five
workflows 2. Workflows with at least one repair: 23 workflows, 8,541 turns,
11,050 calls, 124.64 units; the other 230 workflows: 24,596 turns, 13,974 calls,
266.38 units. Mean cost per workflow 5.42 vs 1.16 units. The event carries
`herdr.reason.length` and the step before/after; in the sampled rows the reason
length is 0, so *why* is not recorded.

**Impact.** The repair cohort is where the dataset's cost lives, and each repair
throws away whatever the expired effects had produced. This is a correlation,
not a per-repair cost: I cannot separate "the repair caused the re-run" from
"the workflow was already expensive and got stuck". Even the weaker reading —
that a manual repair marks a workflow the engine could not finish alone — makes
23 of 253 workflows (9%) a cohort worth reporting in the review itself.

**Confidence.** High on counts and on the cohort split; medium on attribution,
because the reason text is empty and the live store is out of bounds.

**Recommendation (engine/tooling).** Record the repair reason (the command
already has it; `replicate it into telemetry`), which effects were expired, and
the runs retired; surface "repairs" as a workflow metric next to blocked
handoffs. Verify by measuring repairs per 100 workflow-hours and the re-run
cost of a repaired step.

### T2 — the current engine records no triage decision at all

**Evidence.** The whole triage vocabulary stops on 2026-08-14T08:37:20Z: 1,584
`triage_*` rows, and with them `verifier_dispatched` (100 rows, ends
2026-08-14T08:37:20Z) and `verification_started` (107 rows, ends the same
second). The current engine instead emits, for the triage stage:

- `routing.request`/`routing.response`/`routing.classified` with
  `herdr.routing.core.triage.label`/`.profile` — the **model pool** for
  `core.triage`, not the roles or files;
- a `model.classify` `effect.result` on `core.triage-route` (2 rows in the
  snapshot) with no payload beyond kind/step/outcome — the classifier's answer
  to "which verifier roles need to see this change" is not recorded;
- and, when the answer is "none", a `phase_changed` row with outcome
  `no_verifiers_selected` (8 workflows: `ngnb-cases-cannot-be-registered`,
  `only-open-otel-tui-if-not-open-yet-2`, `remove-min-capacity-kw-from-admin-fe`,
  `unify-scoring-rounding-to-two-decimal-places`, `make-ranked-endpoint-default`,
  `sorting-and-filtering`, `create-separation-agent-skill`, `improve-logging` —
  all July/August, so even that outcome is legacy).

**Impact.** Every round of the current generation is unmeasurable in exactly the
way 02c's V2 describes: no role set, no file→role map, no finding count per
round. It also blocks T1/T3/T4's outcome questions — I could not correlate the
classifier's role or pool choices with revisions, blocked handoffs or extra
rounds on more than 16 passes, because the choice itself is not in the record.

**Confidence.** High: it is an absence, checked against both the code
(`src/workflow/effect-runner.ts`, `src/workflow/steps/gates.ts`) and the event
vocabulary of every source.

**Recommendation (engine).** One `triage.plan.selected` event per round in the
current envelope: selected roles, per-role file list (or a count plus digest),
changed-file count, and which path produced it (classifier, default/empty
bypass, or legacy agent). Verify: 100% of rounds carry it, then recompute role
counts and skip rates from it alone.

### T1 — triage narrows exactly, but only to the file

**Evidence.** In the era where triage was an agent step (July/August): triage
109 runs/1,142 turns/5.39 units against verifier 339 runs/7,674 turns/54.46
units — triage is 9.0% of the pair's cost and 13.0% of the turns. Its selection
was honoured exactly: for all 10 workflows whose raw telemetry carries
`triage_role_selected`, the verifier roles that ran are the planned roles plus
`test-verifier`, which by construction is never in `TRIAGE_ROLES`
(`src/workflow/steps/verification.ts`: `VERIFIER_ROLES` minus `test-verifier`,
8 roles when openspec is eligible). Examples: `dashboard-in-process-engine`
planned 3 → ran 4; `architecture-checkup-round-1` planned 1 → ran 2 (the added
role is the test-verifier); `opimize-tui-spacing` planned 2 → ran 2.
`triage_plan_selected` role counts: 1 (×7), 2 (×5), 3 (×4) — median 2, never the
full catalog of 8, so the selection was never equal to the default set in the 16
recorded plans, and the routing step's empty bypass fired 8 times (see T2).

Granularity, however, is one level too coarse: of 204 `triage_file_selected`
rows in the JSONL, 160 (78%) carry `hunk_count = 0`; all 142
`triage_hunk_selected` rows carry `hunk = 0` as well, so the "hunk" layer is
recorded but degenerate. `opimize-tui-spacing` is the extreme: 87 file
selections over 42 changed files across 2 roles, every one at `hunk_count = 0` —
a file list, not a narrowing. Since 02c found verifiers read whole files
themselves, the hunk layer buys nothing today.

**Impact.** 5.39 units to turn "8 possible verifier roles" into "1–3 of them,
with a file list" — cheap for a decision that is honoured exactly, and the
honouring is the load-bearing part (a round cannot be widened). The hunk layer
is the waste inside it: 329 events and the code that produces them for
information no verifier can act on.

**Confidence.** High on the numbers and on the exact-match check; medium on the
value judgement, because three of the four roles in a typical round come from
the plan and one is added by the engine, and I cannot check the plans'
*mis*-judgements without round outcomes (T2).

**Recommendation (engine/schema).** Either populate `hunk`/`hunk_count` from the
diff the triage pass already has, or drop the layer and record file granularity
honestly. Verify: the hunk rows carry a real index, or the event disappears from
the schema.

### T8 — waiting for the developer is the biggest single block of wall time

**Evidence.** 44 `developer.question.created` / 37 answered / 1 expired rows;
in the raw telemetry 23/21/1 across 15 workflows, from which 22 waits are
measurable: total 3,562 s (59 min), median 112 s, max 740 s
(`48fac845-…` core.plan), one expiry at 300 s
(`22d8a7a3-8003-4c5e-ad00-76b610c0e1bf` core.implementation). Blocked handoffs
(`agent.handoff` outcome `blocked`): 18 rows in 12 workflows, all
2026-09-28 … 2026-10-16 — `env-setup-grid-allocation-backend-2` 3,
`find-all-wiki-entries-related-to-agent-spawning` 3, `introdcude-pi-durable` 2,
`env-setup-grid-allocation-backend` 2. Gaps between consecutive completed and
started runs inside one workflow: 9 gaps under 1 s, 201 of 1–10 s (966 s),
190 of 10–60 s (5,352 s), 127 of 1–10 min (29,002 s), 48 of 10–60 min
(56,962 s), 15 over 1 h (218,491 s), plus `prompt_wait_timeout` 7 (4 workflows,
July).

**Impact.** The 59 min of question waits is a hard floor on human latency; the
127 + 48 + 15 large gaps are mostly the same latency plus off-hours, not engine
idle, and I cannot split them from the dataset (there is no "parked waiting for a
human" event with a duration). What is notable is that blocked handoffs are a
*current* phenomenon (18 in three weeks of Sep/Oct) while the old engine's
explicit waiting events (`prompt_wait_timeout`, `verification_timeout`) stop in
July.

**Confidence.** High on the counts; medium on the wall-time split.

**Recommendation (engine/tooling).** Emit `workflow.waiting` on entering a
developer-blocking state with the reason (question, blocked handoff, approval),
and its end; then "agent work vs human wait" becomes a two-number summary per
workflow instead of an inference from inter-run gaps.

### T3 — of the stage gates, only the wiki gate ever decided anything

**Evidence.** Recorded gate evaluations (`effect.result` with
`herdr.effect.kind = model.classify` on a gate step): `core.plan-gate` 3
workflows, `core.review-gate` 6, `core.wiki-gate` 7 (a few appear in both the
JSONL and the span store; worst case ~16 evaluations with a handful of
duplicates). Decisions: 4 `gate.skip` rows, all `core.wiki-gate` and all
2026-09-28/29 (`confidence-gating-removal`,
`findings-dont-render-as-markdown-yet`, `fix-verifier-findings-in-agent-panel`,
`introduce-local-model-support-for-classification`). No plan-gate or review-gate
skip exists anywhere in the snapshot. A gate that decides `run` emits **no**
event: `gate.skip` is the only decision record (`src/workflow/effect-runner.ts`),
so the denominator cannot be recovered from telemetry either.

**Impact.** Small in wall time (a local classifier pass, see T4) but the gates
are the engine's only "should this stage happen" control, and after ~16
evaluations the plan and review gates have never once changed the path. Under
whatever policy was pinned, they are a check that always answers "carry on",
paying an invisible decision. The 4 wiki skips are the counter-example that
makes the mechanism worth keeping — and worth recording.

**Confidence.** Medium: the sample is one month and a handful of workflows, and
the policy in the private-subscription preset is not readable from here.

**Recommendation (engine + config).** Record `gate.decision` for every gate
(decision, latency, and which policy produced it: `auto` classifier or `always`
default), then re-measure after a month. If plan/review gates still never skip,
either delete them (a classifier pass and a 300 s timeout risk per evaluation
for nothing) or keep them deliberately as `always`.

### T4 — routing: free, fast, constant, never a fallback

**Evidence.** 16 `routing.request`/`routing.response`/`routing.classified` passes
in the JSONL (32 dataset rows — the span store duplicates each one), across 8
workflows, 2026-09-28 … 2026-10-16. Model `opencode/jev-1.13-free` at a local
endpoint; `durationMs` median 1,446 ms, min 79, max 1,802, total 17.7 s over the
whole snapshot; state handed in 719–17,633 bytes; `artifacts.count` 0 or 4;
`timeout.ms` 300,000. `steps.asked = steps.applied = 1` and
`herdr.routing.fallback.count = 0` in all 16; `fallback` is `False` for every
step. Labels: 12/16 `cheap-medium-intelligence`
(`pi-opencode-go-deepseek-flash`) spanning plan, implementation, triage,
verification and wiki; 3/16 `free-low-intelligence` (`pi-opencode-free`, wiki);
1/16 `cheapest-low-intelligence` (`pi-opencode-go-luna`, implementation). The
reported confidence of the chosen label is 0.0003–0.289.

**Impact.** Cost ~0 (free local model) and 17.7 s of wall time in total, so
there is nothing to reclaim. Two things to watch: the classifier is effectively
constant, so "routing" currently means "always the cheap-medium pool" for four
of five steps, and a 300 s timeout is 166× the observed maximum — a hung local
endpoint parks a step for five minutes. The outcome question (did the cheap pool
cause later revisions?) is unanswerable at n=16 with no round record: the
workflows that used it are not visibly worse (`add-definition-family-traits`,
646 turns, 0.66 units), but that is not evidence of quality.

**Confidence.** High on the mechanics and the label distribution, low on any
outcome effect.

**Recommendation (config/engine).** Lower the classifier timeout to ~30 s
(≈17× the observed max); define what a sub-0.1-confidence answer should do
(below the current "unusable" bar it is still applied); and, with T2's event in
place, measure revisions and blocked handoffs per pool.

### T5 — engine failures are rare and mostly configuration plumbing

**Evidence.** 2,469 `effect.result` rows, 21 with outcome `error` (0.85%); 243
ok/complete; the rest carry no outcome attribute. The 21 errors deduplicate
(`v_events`) to: `name must be at most 40 characters` 7 (in 2 workflows,
`verifiers-dont-show-findings-in-agent-list` 4,
`investigate-worktree-handling-differences-between-luvus-and-herdr` 3),
`Luvus worktree.create returned no workspace identity` 3 (3 workflows, all at
`core.route-plan`), a worktree created at the wrong commit 2, `Preparing
worktree ... is already used by worktree` 2, `workflow execution settings
adoption required before delivery` 3, `env-setup write guard` 2, and
`assignment exceeds 98304 bytes` 2 (both at `core.triage` in
`c42b6d2c-08c3-45f5-a6ef-3a251eb4afe3`, 2026-10-05T08:44:42Z, back to back for
`artifact.write` and `agent.launch`). The raw JSONL, which counts each event once
per source, shows the name-length and worktree-identity classes at 11 and 6
respectively; I use the deduped numbers. Retries:
`herdr.effect.attempt` is present on 144 rows and 8 of them are attempt ≥2
(2×4, 3×2, 4×2) — all `workspace.setup` failures, in 2 workflows that burned 3
extra attempts each at `core.implementation`. Latency: `agent.launch` p50 41 ms
(n=36), `workspace.setup` p50 1,281 ms (n=25, max 12,706), `model.classify`
p50 1,746 ms (n=21, max 15,188), `workspace.cleanup` p50 924 ms (n=10). 22
`agent_launch_failed` rows in 9 workflows, all 2026-08-03…06 (legacy engine), 1–5
per workflow.

**Impact.** The engine's own overhead is small: failures under 1%, retries
confined to workspace setup and worth tens of seconds, launch/turnaround
latency in seconds. The two failures that cost something are the assignment-size
cap at `core.triage` (a large change cannot even be handed to triage: 2 events,
no recovery recorded) and the settings-adoption delivery error (3 events, each
blocking delivery). Workspace identity and name-shaped errors are 14 of the 21.

**Confidence.** High on counts; low on the cause of the missing outcome
attribute and on what "no recovery recorded" cost.

**Recommendation (engine).** Fail the triage step with a bounded, actionable
class (already present) and *record what happens next* (the run's next state) —
today the two 96 KiB events are the workflow's last recorded words. Verify:
`core.triage` failures lead to a recorded retry, a smaller assignment, or a
bounded blocker, never to silence.

### T7 — the global-search guard fired on exactly the expensive class, once

**Evidence.** 9 `global_search_blocked` rows in 6 workflows, all
2026-08-03 … 2026-08-12, from `planner` (3), `quality-verifier` (3), `triage`
(1), `worker` (1), `security-verifier` (1). The dataset keeps only the count;
the span store keeps the blocked `command` attribute, from which the shape is
classifiable without reproducing it: 3 whole-filesystem `find /` walks, 2 walks
from a home directory, 1 from `/tmp`, 3 other shapes (all 100–340 characters —
one-shot commands, not interactive sessions). No block is recorded in Sep/Oct,
although October alone has ~5,100 tool spans.

**Impact.** The guard blocked exactly the pattern that produced the 20-minute
recursive grep in the env-setup run (2f), which is the strongest thing one can
say for it: 9 turns were not spent on a whole-disk walk. What it did *after* the
block is unrecorded (no follow-up event), so the saving cannot be quantified
beyond the calls themselves, and I cannot tell whether the Sep/Oct silence is
better agent behaviour or a change in what the guard still catches.

**Confidence.** Medium — the direction is clear, the volume is tiny, and the
post-block behaviour is missing.

**Recommendation (engine/tooling).** Record one event after a block naming the
class of the blocked command (already computable) and whether the next call was
scoped; keep the guard. Verify: blocked-call rate per 1,000 tool calls, and the
share of blocks followed by a scoped call rather than a retry of the same shape.

## Justified — looked wasteful, but is not

- **Triage's own cost.** 5.39 units to narrow 8 candidate roles to 1–3 and to
  hand each role a file list, with the narrowing honoured exactly in every case
  I could check. Cheaper than one verifier run (54.46/339 = 0.16 units each).
- **`test-verifier` running in every round.** It is deliberately excluded from
  `TRIAGE_ROLES`, so the engine adds it; that is a design decision, not triage
  failing to narrow.
- **The routing and gate classifier passes.** Free local model, ~1.4 s median,
  and they replaced an agent-side `model_selected` mechanism (42 rows in July).
  The cost is not the money, it is the 300 s timeout ceiling and the missing
  decision record.
- **The 8 retried effects.** All `workspace.setup`, all genuinely retryable
  infrastructure, each retry after ~1.3 s of work; the alternative (failing the
  workflow) is worse.
- **The large inter-run gaps.** 15 gaps over an hour and most of the 48 of
  10–60 min are overnight or human latency, not the engine: within a session the
  engine turns work around in seconds (9 gaps <1 s, 201 of 1–10 s).
- **`agent_launch_failed` (22), `model_selected` (42), the whole `triage_*`
  family (1,584).** Legacy-engine behaviour, superseded; no current cost.
- **The 57 "all-failed" runs.** Not waste and not a finding: they are 02c's X1
  artifact (see above).
- **`c42b6d2c-…`'s two 96 KiB errors.** A guardrail firing, not a loop: two
  events, no retry storm.

## Data limits

- **Failure-only generations.** The July legacy envelope and the July/August
  span subsets record no successful tool call, so any failure rate, retry
  count or "dead tool surface" statement over the whole dataset is inflated
  (X1). Era-split numbers are in X1.
- **No current triage/gate record** (T2, T3): role selection, file→role map,
  and every `run` decision of a gate are absent.
- **Synthetic runs.** In July/August, `telemetry.main-store` rows are per
  (workflow, role) aggregates, so "a run" there may be several attempts.
- **Cost coverage is uneven.** Sep/Oct verifier runs record 3,576 turns for 0.83
  units; cost shares across eras must be read with turns.
- **No duration for legacy rows**: `duration_ms` is null for most July/August
  runs, so wall time there is derived from event timestamps.
- **The live store is out of bounds**, so T6's repair reasons and the
  `48fac845-…` 10-repair sequence could not be read; the three workflows the
  assignment names as having today's SSH/push failures
  (`env-setup-staged-config-root`, `tui-mouse-navigation`,
  `orchestrator-event-subscriptions`) each contain exactly one
  `workflow.started` row and no spans in the snapshot, so those retry loops and
  the event-bus gap are **not observable here**. The one push failure that is
  recorded is `opimize-tui-spacing`, 2026-08-14T08:41:14Z, class
  `Permission denied (publickey)` on `git push --set-upstream`, with the
  workflow closing 33 s later; three October `delivery.push` effect errors carry
  `workflow execution settings adoption required before delivery`.
- **The private-subscription preset's gate policies** live in the user config
  (out of bounds), so T3's policy reading is an inference.
- **Dataset discrepancies** against the assignment's brief:
  `triage_file_selected` 923 (not 869); `effect.result` 2,469 (not 2,453);
  `agent_launch_failed` 22 (not 21); `verification_timeout` 8 plus a separate
  `verifier_timeout` 2; `routing.classified` 32 rows for 16 distinct passes
  (the span store duplicates each JSONL event and the event dedupe key,
  workflow+run+event+second, does not collapse them); `global_search_blocked`
  9 (not 8). `recovery` and `git` have 1 and 3 runs: below any threshold.
- **`no_verifiers_selected`** appears as a `phase_changed` *outcome* with no
  workflow-level detail (detail dropped to a hash), so I have the 8 workflows
  but not why the classifier answered empty.
- **`global_search_blocked`'s command** exists only in the span store; the
  dataset keeps the count.

## Recommendations ranked by expected saving per effort

1. **Record the triage and gate decisions (engine, small).** One
   `triage.plan.selected` per round and one `gate.decision` per gate evaluation,
   with roles, files (or counts), source (classifier/default/bypass) and
   latency. Unblocks T2, T3 and 02c's V2; without it every future dive on gates,
   triage and routing is a guess. *Verify:* 100% of rounds and 100% of gate
   evaluations carry a row; recompute the role-count and skip-rate distributions
   from those rows alone.
2. **Split every failure metric by recording generation (tooling, small).** Use
   `source-recording` (added here) or mark rows from a source whose month
   recorded no success. Cheap, and it prevents a repeat of X1 in the next
   snapshot's reports. *Verify:* the September/October failure rate (2.4%)
   recomputes from the split; no report quotes a mixed-era rate.
3. **Record `operator.repair`'s cause and effect (engine, small).** The reason
   string, the expired effect ids, and the retired runs; then show a repair
   count in the workflow view. 23 workflows carry 124.64 units (31.9%).
   *Verify:* 100% of repairs carry a non-empty reason and an expired-effect
   count; watch repairs per 100 workflow-hours.
4. **Fix or remove the hunk layer in triage (engine/schema, small).** 160/204
   file selections carry no hunk and all 142 hunk rows say index 0, while
   verifiers read whole files. *Verify:* either real hunk indices appear or the
   event is gone.
5. **Lower the classifier timeout from 300 s to ~30 s (engine, small).** The
   observed maximum is 1.8 s. *Verify:* no classifier pass exceeds ~20 s, and a
   hung endpoint delays a step by seconds, not minutes.
6. **Make a low-confidence classifier answer explicit (config, medium).**
   Every pass chose the same pool with 0.0003–0.289 confidence and no fallback.
   Either let low confidence fall back to the pool default by design, or accept
   and document that routing is a constant. *Verify:* the label distribution or
   the fallback count changes deliberately rather than by accident.
7. **Decide the plan and review gates on evidence (config, small).** 13
   evaluations, 0 skips. Either measure them for another month with (1) in place
   or remove them. *Verify:* skips per evaluation per gate stage.
8. **Teach the review to read a repair as a finding (task shape, medium).** A
   workflow the engine could not finish unaided is the cohort with 31.9% of the
   cost; make the repair part of the workflow's history the review sees.
   *Verify:* the review's summary lists repairs and their re-run cost.

## Open questions

- Why were the 42 repairs needed? The snapshot's rows carry an empty reason and
  the live store is out of bounds; without it T6 stays a correlation.
- Did the three workflows with today's push failures converge, and how many
  retries did the SSH failure cost? They have no telemetry beyond
  `workflow.started` in the snapshot.
- What was `gates` set to in the private-subscription preset during
  September/October? T3's "no-op" reading depends on it being `auto`.
- Did the 4 wiki-gate skips remove documentation a reader later missed? No
  follow-up signal exists.
- Why did the routing classifier never fall back, and is a 0.0003-confidence
  answer being treated as usable by design or by accident?
- What did the agent do after each of the 9 blocked global searches — a scoped
  call or a retry in another shape? The next tool call is not joined to the
  block.
- The 719 `triage_file_selected` rows that exist only in the span store (against
  204 in the JSONL, 923 total): are they runs the dataset never attributed to a
  workflow, or the same events counted twice? The span store covers changes with
  no telemetry JSONL in the snapshot, so both readings are possible, and the
  dataset's event dedupe key (workflow+run+event+second) does not collapse them
  because the two sources spell the workflow id differently.
- Do the September/October verifier rounds run the roles the classifier asked
  for? Unanswerable until recommendation 1 lands.
