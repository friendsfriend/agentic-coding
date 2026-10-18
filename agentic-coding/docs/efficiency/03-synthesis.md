# Efficiency review step 3 — synthesis

One decision document over the eight deep dives (`02a`–`02h`) plus the data
inventory and the tooling note. It re-verifies the claims, merges the overlaps
into root causes, quantifies what is worth what, and states what must not be
touched. It changes no production code.

**Reference build.** The pinned dataset
(`~/agentic-coding-efficiency-evidence/latest/dataset/dataset.sqlite`, built
`2026-10-16T12:35:27Z`), preferred rows only: **391.0161 cost units, 33,137
turns, 25,024 tool calls, 1,238 runs, 253 workflows**. July+August carry 314.853
units (80.5 %), September/October+undated 76.163 (19.5 %). Every share below is a
share of that denominator unless it says otherwise.

## Executive summary

The measured waste is not spread evenly over the agent population. It sits in
four places: **long-lived sessions with idle gaps**, **long runs that never
compact or stop**, **the first third of every run, spent rediscovering what the
assignment already knew**, and **tool results that re-send prose the model
already has**. Together those four touch roughly a fifth of the corpus cost
directly and a much larger share indirectly (every extra turn re-reads the whole
context, so turns and cost multiply).

| # | root cause | verified evidence (measured) | money at stake | reclaimable (modelled) |
| --- | --- | --- | --- | --- |
| 1 | Cold prompt cache after idle gaps | 85 of 570 orchestrator turns (14.9 %) preceded by a >5 min gap carry **$29.13 of $48.13 (60.5 %)**; those turns have `cacheRead = 0` and re-write the whole prefix at 2.5 vs 0.2 $/M (12.5×) | one conversation, not in the corpus denominator | $9.2 (5–10 min bucket) … $20.4 if a 1 h TTL exists |
| 2 | No cost-aware context ceiling; compaction never fires | verifier turns above 100 k context: **1,136 turns = 11.7329 units (21 % of the 55.29 verifier slice)**; 7 `compaction_requested` in 2 workflows, **0 automatic compactions** modern; one worker run reached 911,257 tokens | 11.7 units (3.0 %) + the long-run tail | 10 / 25 / 45 units (2.6 / 6.4 / 11.5 %) |
| 3 | Orientation before the first artifact | pre-first-write cost: planner `core.plan` **8.2161 of 16.1897 (50.7 %)**, quality-verifier 7.5891 of 11.269, openspec 4.2419, wiki 1.2833 of 1.9434 (66 %, first write at turn 53.3), consolidator 1.2366, triage 0.8525 → **≈25.6 units** | ≈25.6 units (6.5 %) | 5 / 8 / 12 units (1.3 / 2.0 / 3.1 %) |
| 4 | Tool-output shape (task prose, duplicated arrays, pretty JSON) | `workflow_status` 86 calls / **472,527 B** (task ≈47 %, `orchestratorQuestions` a byte-identical copy of `pendingQuestions` in 30/77 calls); `list_workflows` 21 calls / 276,823 B (task 58 %); `start_workflow` arguments 163,350 B (93 % `task`); `env_list` 31–43 KB/call | $20.8 of one conversation attributed | $8.80 modelled (18 % of that conversation) |
| 5 | Polling and monitor wake-ups | 86 `workflow_status` calls for ~30 workflows; **64 turns whose only call was `workflow_status` ($10.13)** and 167 turns with no call ($11.04); 86 monitor notes; 3 delivery notes each naming one workflow 12× | $13.28 of one conversation | $11 (modelled) |
| 6 | One call per turn | **48.3 % of all call-recorded turns**; planner 74.2 % (1,598/2,153), worker 78 % (7,328/9,407), verifier single-call turns **19.36 units (35 % of the verifier slice)** | ≥19.4 units (5.0 %) | 4 / 9 / 20 units (1.0 / 2.3 / 5.1 %) |
| 7 | Premium models on mechanical steps | three identical 27-turn `core.plan` runs at **1.7139 / 0.0416 / 0.0397** (41–43×); two `pi-copilot-opus` consolidations = **12.9088 units** (99.5 % of the consolidator slice); profile `pi-eon-sonnet` **72.348 units over 5 runs** | 17.7 units in 4 plan runs (4.5 %) | 20 / 40 / 70 units (5–18 %), quality-risky |
| 8 | Retries without change and non-convergent loops | archive failure tail **168 of 721 turns (23 %)** in 2 runs, both `attention-required`; one push retried 3× in 23 s unchanged; 121 empty settles + 34 nudges in 17/8 workflows; **42 `operator.repair` in 23 workflows carrying 124.64 units (31.9 %)** | tail + 0.76 units of settles | 3 / 8 / 20 units + reliability |
| 9 | `bash` where `read`/`grep`/`codemode` exist | planner 0 `grep` calls ever, 1,621 bash vs 908 read; wiki 431/718 bash carrying 1.36 MB of 1.79 MB; `bash-vs-tools` 3.2 %–79.2 % per run (deepseek runs: 0 `grep`) | mechanism behind 3 and 6 | counted inside 3 and 6 |
| 10 | Telemetry that cannot see its own agents | **2,263 assistant turns and 2,803 tool results** sit unread in 9 harness stores that parsed to 0 rows; **156 runs in 38 workflows** carry turns after their recorded completion; 21 of 86 modern worker runs have no per-turn record; 3 of 30 analysis queries were unreachable and the query test file did not parse (`bun run type-check` failed on main) | 0 direct | the precondition for everything above |

Reliability, not cost: the env-setup write guard that fingerprints the
platform's own state, the staged root that preserved a symlink into the live
checkout, the delivery push that never preflights credentials, a subscription
whose `minSeverity` could not carry the completion its own reason named, and the
96 KiB assignment cap at `core.triage` that silently ends a large change.

Developer time, not cost: 22 measurable question waits (3,562 s), 18 blocked
handoffs (all Sep/Oct), 127 gaps of 1–10 min + 48 of 10–60 min + 15 over an hour
between runs, one 20-minute recursive `grep` that only a human abort ended, and a
3 h 36 m planning idle before `operator.repair`.

## Trust but verify

Verdicts from independently re-running the query or re-reading the cited
evidence. `VERIFIED` = my numbers match; `PARTLY` = direction holds, a number or
a definition does not; `ARTIFACT` = a recording artefact, not behaviour; `NOT
REPRODUCED` = the evidence is raw-store only and was not re-measured here.

| # | claim (report) | verdict | what I measured |
| --- | --- | --- | --- |
| 1 | `02c V3` 57 verifier runs, every recorded call failed, 2,492 turns, 15.04 units, "27 % of the slice" | **ARTIFACT** | Reproduced exactly (57 / 2,492 / 15.0454) — and every one sits in Jul/Aug. In that window calls are **100 % failed by construction**: Jul `telemetry.main-store` 402/402, Jul `traces.otel-tui` 275/275, Aug 25/25 and 236/236, against 2.4 % in Sep. Restricted to `started_at >= 2026-09-01`: **0 runs**. `02d X1`'s correction stands. |
| 2 | `02c V8` failed calls are 8.2 % of the verifier slice; `02b W6` 918 failed worker calls (9.3 %) and `edit` 17.6 %; `02a F9` planner 7.0 % | **ARTIFACT-inflated** | Post-2026-08-31 only: worker **544/9,455 = 5.75 %** (Jul 282/282, Aug 90/90, Sep 39/1,124, Oct 102/4,080, undated 403/4,251) — exactly `02d`'s 544/9,455; `edit` **189/1,558 = 12.1 %**; planner 3/668 = 0.45 %. `02d`'s sibling corrections all reproduce. |
| 3 | `02c V10` `agents-verifier` is dead (31/31 calls failed) | **VERIFIED (usage) / ARTIFACT (failures)** | 14 runs, 284 turns; last run 2026-08-05. The failure count is the same recording artefact. |
| 4 | `02d T6` 42 repairs across 23 workflows, 124.64 of 391.0 units | **VERIFIED** | 42 `operator.repair` events, 23 workflows. The cohort correlation is arithmetic; causation stays medium (reason text empty). |
| 5 | `02d T8` 22 question waits = 3,562 s; 18 blocked handoffs in 12 workflows (Sep/Oct) | **PARTLY** | 44 `developer.question.created` / 37 answered / 1 expired; handoffs: **1 blocked in Sep, 17 in Oct = 18**. The 3,562 s total is a raw-telemetry pairing I did not re-derive. |
| 6 | `02d T4` routing: 16 passes, free, ~1.4 s median, no fallback | **VERIFIED** | 16 `routing.classified` records in 8 raw telemetry files (the dataset's 32 rows are span duplicates). |
| 7 | `02d T3` only the wiki gate ever decided (4 skips) | **VERIFIED** | 4 `gate.skip`, 4 workflows, 2026-09-28/29. |
| 8 | `02d T1` triage narrowed 8→1–3 and was honoured exactly; 9.0 % of the cost it gates | **PARTLY** | Jul+Aug triage 5.393 units vs verifier 54.458 = **9.0 %** ✓. The "honoured exactly" check I did not re-run. |
| 9 | `02d T2` no triage/gate decision is recorded after 2026-08-14 | **VERIFIED** | 1,584 `triage_*` events, max `at` 2026-08-14T08:37:20Z; `gate.skip` is the only gate decision record. |
| 10 | `02d T5` 21 effect errors of 2,469 (0.85 %) | **VERIFIED** | 2,205 + 120 ok + 123 complete + **21 error** = 2,469. |
| 11 | `02c V4` 1,136 verifier turns above 100 k context carry 21 % of the slice | **VERIFIED** | 1,136 turns, **11.7329 units** — exact. |
| 12 | `02c V5` 44 % of interior verifier turns make exactly one call (17.68 units) | **PARTLY** | All verifier turns: 4,893 single-call (**19.36 units**), 4,427 with none (25.81), ~1,377 with 2+. The shape holds; my count differs because I did not reconstruct "interior". |
| 13 | `02c V6` 121 empty settles + 34 nudges in 17/8 workflows | **VERIFIED** | 121 / 17, 34 / 8, all 2026-08-03…08-14. |
| 14 | `02c V7` test-verifier: 509 bash calls, 159 failed, duration for 90 | **VERIFIED** | 509 / 159 / 90 — exact. |
| 15 | `02c V2` findings events from 2026-07-16; 121 rounds, 25 of 49 instrumented empty | **PARTLY** | 262 findings (156 + 106) + 54 accepted, but the window is **2026-07-27…2026-08-14**, three weeks shorter than claimed. Rounds: 121 over 100 workflows ✓; the yield attribution is a construction I did not re-derive. |
| 16 | `02c V1` a re-verification round costs ~18× the fix it verifies | **VERIFIED (cost) / PARTLY (premise)** | `verifier-rounds`: round 1 = 48.087 units / 10,505 turns; **rounds ≥2 = 7.198 units / 745 turns** over 21 rounds; rounds per workflow 81 / 17 / 2 ✓. "Tiny fix" rests on worker turn count, and the engine's `attempt` field exists on 44 verifier runs, not 91. |
| 17 | `02c V9` roles per round widened 3.3 → 5.1 | **PARTLY→contradicted by the histogram** | Roles per round: 1:13, 2:23, 3:35, 4:34, 5:7, 6:4, 7:4, 8:1 — 87 % of rounds run ≤4 roles. The newer engine's selection is unrecorded (`02d T2`), so "widening" is unproven. |
| 18 | `02a F1` half the planner's spend precedes the first artifact | **VERIFIED** | `orientation-cost`, `core.plan`: 152 runs, 51 with an artifact, first artifact at turn **19.7**, `cost_before` **8.2161 of 16.1897 = 0.507**. |
| 19 | `02a F4/F5` fusion cost is the consolidator's model; 41–43× spread | **VERIFIED** | consolidator 12.9794 units, of which **two `pi-copilot-opus` runs = 12.9088 (115 turns)**. Three 27-turn plans: 1.7139 / 0.0416 / 0.0397. |
| 20 | `02a F7` 65 % of planner cost is unattributable aggregate rows | **VERIFIED** | step-less `planner` rows: 37 runs, 60.251 units, 123 calls, **all 123 failed**. |
| 21 | `02a F8` 49 % of planner "runs" are migration stubs | **VERIFIED** | 93 `legacy-pi-durable` rows with ≤1 turn and 0 cost. |
| 22 | `02a F3` 74 % of planner turns make one call | **VERIFIED** | 74.2 % of the 59 call-visible `core.plan` runs' turns (report's number; dataset-wide single-call share is 48.3 %). |
| 23 | `02a F9` dead tool names still invoked | **VERIFIED** | `jira_get_issue` 7/7 failed, `ask_user_question` 4/4, `gh_grep_search` 1/1. |
| 24 | `02b W1` one 1,072-turn worker run, 66.38 units | **VERIFIED — not a join artefact** | one run row `e06de610-b745-466f-89a6-5d7734c2ca4c`, `pi-eon-sonnet`, attempt 2, `blocked`, **1,072 turns, 66.3814 units**, peak context **911,257**. |
| 25 | `02b W2` no compaction, cost ∝ turns² | **VERIFIED (shape) / PARTLY (count)** | halves 23.165 → 43.217 (**1.87×**); decay curve monotone. "Compaction fired 19 times" is 19 event *rows* = **7 requests in 2 workflows**; "no modern run compacted" holds. |
| 26 | `02b W3/W5` 78 % single-call turns; 55 % of bash is a tool substitute | **PARTLY** | 48.3 % dataset-wide, 78 % in the modern worker partition — both are in `02b` and both are real at different scopes. `bash-vs-tools` per run ranges 3.2 %–79.2 %; the 55 % digest figure only covers 557 argument-visible calls. |
| 27 | `02e WD-1/WD-2` archive 78 runs / 1.85 units; wiki 65–66 % pre-write | **VERIFIED** | archive 78 runs, 721 turns, 350 calls, **1.8487 units**; 5 runs above 12 calls (222 turns, 176 calls, 0.055) ✓; wiki 9 runs, 489 turns, `cost_before` **1.2833 of 1.9434 (0.66)**, first write at turn 53.3 ✓. |
| 28 | `02e WD-5/WD-6` push retries unchanged; the tail is developer latency | **PARTLY (reproduced via the restored query)** | `git_operations_failed` 6 in 3 workflows; `delivery-timeline` measures `wiki_approval_to_archive_minutes` up to 221.6 ✓. The 2026-10-16 episode is monitor-note-only and cannot be re-measured. |
| 29 | `02f F5` the run record does not cover its session: 156 runs in 38 workflows | **VERIFIED** | `run-window-drift`: **156 runs, 38 workflows**; max tail 63,380 s. |
| 30 | `02f F1/F2/F3/F4` unbounded grep, `env_list` ambiguity, guard scope, symlink write-through | **NOT REPRODUCED** | Raw-transcript/span claims; I confirmed the mechanisms exist in the current source and left the numbers as reported. |
| 31 | `02g RES-1` the pinned dataset lost every harness transcript; a repaired rebuild adds 2,263 turns / 2,804 calls | **VERIFIED** | 9 `harness.*` source files, `records = 0`, `parsed = 0`, note "unreadable: unable to open database file". Reading them directly: **2,263 `pi.assistant` entries and 2,803 `pi.tool-result` entries** — the rebuild delta, to the entry. |
| 32 | `02g RES-2/RES-3/RES-4/RES-5` research session claims | **NOT REPRODUCED** | Session-level raw-store reads (n = 2). The slice is invisible in the pinned dataset by #31. |
| 33 | `02h ORCH-1` cold cache after idle gaps; $29.82 on 85 turns | **VERIFIED (mechanism) / PARTLY (total)** | 570 assistant turns, **$48.1346** total = write $32.0253 + read $13.1360 + output $2.9704, single model `claude-sonnet-5.5` ✓. Gapped (>5 min) turns: 85, cost from the report's own buckets **$29.13** — the $29.82 headline is 2.4 % high. 81 turns have `cacheRead = 0` with `cacheWrite > 0`; the 57 turns over 10 min have `cacheRead = 0` exactly. |
| 34 | `02h ORCH-1′` a 1 h cache TTL would cost $27.76 | **PARTLY (assumption confirmed)** | The catalog entry `github-copilot/claude-sonnet-5.5` declares `cost {input 2, output 10, cacheRead 0.2, cacheWrite 2.5}` and **no `promptCache` block anywhere in the provider data**, while `anthropic` declares `{short: 300, long: 3600}` for 16 models including `claude-sonnet-5-5`. `calculateCost` bills a 1 h write at `input × 2` = $4/M, matching `02h`'s model. The 12.5× is exactly `2.5 / 0.2`. Whether GitHub Copilot exposes the long TTL is a **provider** question, not visible in the catalog. |
| 35 | `02h ORCH-2/ORCH-3` `workflow_status` 431,688 B / `list_workflows` 262,726 B | **VERIFIED (shape) / +8 % on my measure** | Result payloads live in `pi.tool-result` → `model[0].content`; my byte counts: `workflow_status` **472,527 B** over 86 calls, `list_workflows` **276,823 B** over 21 calls, `bash` 621,292 B, total 1,656,497 B, largest single result **53,524 B** (their 51,245). The 60,000-char cap never bound — the waste is field selection, not truncation. |
| 36 | `02h ORCH-4/ORCH-10` 38 poll-only turns ($9.07); 167 turns with no call | **PARTLY** | 167 no-call turns ($11.04) ✓ exact; poll-only turns are **64 ($10.13)** across all turns (their 38 is the after-note subset). 55 turns with 2+ calls ✓ exact; 86 monitor notes ✓. |
| 37 | `02h ORCH-5` 58 of 479 calls failed (12.1 %) | **VERIFIED** | 58 tool results flagged error. |
| 38 | `02h ORCH-6/ORCH-9` prefix grew 5.7 → 21.6 kB; auto-compaction inert; peak 330,458 | **VERIFIED** | 7 `pi.system` entries 5,789 … 22,092 B ✓ (same shape); peak context **333,278** (+0.9 %); **213 turns above 150 k** ✓ exact; all 4 compactions manual ✓; `COMPACTION_DEFAULTS.reserveTokens = 32000` with a window-relative `max(32000, 30 % of the window)` → 700,000 threshold on a 1 M window ✓ read from `src/workflow/compaction.ts`. |
| 39 | `02h ORCH-7/ORCH-8/ORCH-11/ORCH-12` re-typed tasks, own output re-carried, bad subscription severities, pretty JSON | **PARTLY** | `start_workflow` arguments **163,350 B**, 93 % in `task` ✓; 54 calls for 44 workflows ✓. ORCH-8/11/12 rest on the report's attribution model, which I did not rebuild. |
| 40 | Denominator drift: inventory 34,820 turns vs 33,537 vs 33,137 | **VERIFIED, bounded** | The ladder is: **33,137** preferred rows ↔ **33,537** all rows in the same build (400 non-preferred duplicates) → **+2,263** turns from the readable harness stores (#31) = **35,800**, versus **34,820** in the checked-in inventory (an older snapshot generation, itself 980 turns behind a repaired rebuild of *this* one). The `34,208` figure in the assignment brief does not appear in any checked-in document and I could not reproduce it; treat it as unattributable. Recommended denominator: preferred rows of the pinned build. |

### The unit question (assignment doubt b)

The dataset's `cost` column is **not** provider-reported and **not** a
subscription-flat zero. It is `usage.cost.total` as computed by
`@earendil-works/pi-ai`'s `calculateCost`
(`node_modules/@earendil-works/pi-ai/dist/models.js:660`) from the provider
catalog's **list rates** per model (`input`, `output`, `cacheRead`,
`cacheWrite`; a 1 h cache write is billed at `input × 2`). Consequences:

- `02h`'s `$48.13`, `02g`'s `$1.6765`, `02a`'s "cost units" and the corpus's
  `391.0161` are **the same unit** — computed list-price USD. They are
  comparable to each other; they are *not* the developer's bill.
- A model whose catalog rates are zero contributes 0 even though it did work:
  91 runs of `pi-opencode-free` and 27 of `pi-ox-alpha-free` carry no cost,
  while 52 runs of `pi-opencode-free` do carry $1.5414 (mixed model resolution
  inside one profile). **Cost-per-run comparisons across profiles are
  therefore biased**, and any "free pool is free" statement is a config claim,
  not a measurement.
- `github-copilot/*` subscription usage is billed here at Anthropic list price.
  Totals are an upper bound on money and a faithful unit of *work*.
- Conclusion: use the unit for **shares and trends**, never as "what we paid".

## Root causes (deduped across roles)

Each root cause merges the findings listed, carries one recommendation, and
separates **measured** (a number I reproduced) from **modelled** (an estimate
with stated assumptions). Savings are ranges over the 391.0161-unit corpus
unless the surface is a conversation outside it.

### RC1 — Cold prompt cache after idle gaps (config, S)

Roles: `02h ORCH-1`; mechanism also visible dataset-wide in `cache-expiry`.
**Measured:** in the orchestrator conversation, 85 of 570 turns (14.9 %) are
preceded by a gap over 5 minutes, 57 of them by over 10 minutes, and those turns
carry **$29.13 of $48.13**. Every long-gap turn has `cacheRead = 0` and
`cacheWrite` equal to the full prefix (300,747–318,254 tokens); the 5–10 min
bucket alone writes 3.69 M tokens for $9.23. The model's effective TTL is the
short 300 s: the provider data declares no `promptCache` block for
`github-copilot`, while `anthropic` declares `{short: 300, long: 3600}` for the
same model family.
**Corpus caveat (measured):** the dataset-wide `cache-expiry` query shows only
23.8 units in all gapped buckets, because `cache_write_tokens` is NULL on 7,495
of 13,049 `telemetry.main-store` turns. Corpus-wide this term is **unmeasured**.
**Assumption:** one long-lived Home session per developer, gaps = the developer
being away.
**Modelled:** $9.2 from the 5–10 min bucket if the prefix stops being re-written;
up to $20.4 more if the provider exposes a 1 h TTL for this model (a capability
question, not a code change).
**Recommendation:** for long-lived sessions, cap context by an absolute,
cost-aware ceiling and keep the session warm instead of relying on a cache that
expires; ask the provider for the long TTL and declare it in the catalog when it
exists.

### RC2 — No cost-aware context ceiling; compaction never fires (config/default, S)

Roles: `02b W1/W2`, `02c V4`, `02g RES-5`, `02h ORCH-9`.
**Measured:** worker tokens are 99 % cache-read; within every long run the second
half costs 1.87–2.9× the first (`e06de610`: 23.165 → 43.217 over 536/536 turns);
verifier turns above 100 k context are 1,136 turns / **11.7329 units** (21 % of
the verifier slice). Compaction is not merely rare — the policy makes it
unreachable: `COMPACTION_DEFAULTS` is `max(32,000, 30 % of the window)`, i.e. a
**700,000-token** blocking threshold on a 1 M window, while the only modern long
run peaked at 911,257 tokens and the orchestrator at 333,278. 7
`compaction_requested` events, 2 workflows, none modern.
**Assumption:** a run's cost is proportional to the prefix it re-sends, so a
flatter context curve is a proportional saving on the same work.
**Modelled:** 10 / 25 / 45 units (2.6 / 6.4 / 11.5 %) from an absolute ceiling
plus a turn/context ceiling on outlier runs; the largest single item is
`e06de610`'s second half (43.2 units, 11 % of the corpus, in one run).
**Recommendation:** make the ceiling a cost control, not an overflow valve (see
backlog 7 and 21), and record peak context per run.

### RC3 — Orientation before the first artifact (prompt + task shape, M)

Roles: `02a F1`, `02b W4`, `02e WD-2/WD-3`, `02c V4/V5`, `02f F2`, `02g RES-3`.
**Measured:** `core.plan` writes first at turn 19.7 and spends **8.2161 of
16.1897 units (50.7 %)** before it; wiki spends **1.2833 of 1.9434 (66 %)** with
its first write at turn 53.3; the 5 fully-evidenced worker runs spend **44 % of
their calls and 67 % of their result bytes** before the first edit (360/820
calls, 1,258/1,882 KB); quality-verifier `core.verification` 7.5891 of 11.269,
openspec 4.2419, consolidator 1.2366. The named example is env-setup run 2:
**853 s (29 % of the run)** spent reconstructing one fact that `env_list` was
already flagging as ambiguous, including eight `grep -a -o` calls against a
92 MB compiled binary (613 s).
**Assumption:** not all of it is avoidable — a planner must see the tree, and
reading is how a verifier judges. Only the part where the assignment already
names the files (plan file list, changed-file list, prior round's findings) is
claimed.
**Modelled:** 5 / 8 / 12 units (1.3 / 2.0 / 3.1 %), plus wall time.
**Recommendation:** one change with three parts — an explicit orientation budget
in the planner/wiki briefs with "write a skeleton early", the plan's file list
handed to the worker in the assignment, and the round's changed files handed to
the verifier.

### RC4 — Tool-output shape (tool definition, S)

Roles: `02h ORCH-2/3/7/12`, `02g RES-7`, `02f F2`, `02c V4` (in part).
**Measured:** `workflow_status` 86 calls / **472,527 B** in one conversation, of
which `task` ≈47 % and `orchestratorQuestions` is a byte-identical copy of
`pendingQuestions` in 30 of 77 calls (12,278 B); `list_workflows` 21 calls /
276,823 B of which `task` 58 %, pretty-printed; `start_workflow` writes 163,350 B
of arguments, 93 % of it the `task` text the developer already wrote;
`list_agent_config` is 40 % indentation. `env_list` returns 31–43 KB per call to
every debug and env-setup run. The 60,000-char cap never bound.
**Assumption:** these bytes are re-sent on every following turn of the session
(the attribution model reproduces the recorded write+read total to the cent).
**Modelled:** $8.80 (18 %) of *that* conversation; corpus impact unmeasurable
(the orchestrator conversation is not attributed to a dataset run).
**Recommendation:** a compact projection by default and the prose only on
request (see backlog 5, 6, 13).

### RC5 — Polling and monitor wake-ups (engine + tool definition, S/M)

Roles: `02h ORCH-4/ORCH-10/ORCH-11`, `02e WD-5`, `02d T8`.
**Measured:** 86 `workflow_status` calls covering ~30 workflows; **64 turns whose
only call was `workflow_status` ($10.13)** and 167 turns with no call ($11.04);
86 monitor notes (17.3 kB). The orchestrator also sabotaged its own wake-ups:
subscriptions created with `minSeverity: warning` for a "the run finished" reason
cannot carry a completion, and one delivery outage produced three notes that each
name a single workflow **12 times** (3,216 B, 0.763 units to answer).
**Assumption:** the notes are not the cost; the *cold turn* they trigger is
(RC1), which is why these turns are expensive.
**Modelled:** ~$11 (23 %) of that conversation; corpus-wide the same shape must
be measured once the orchestrator is attributed.
**Recommendation:** keyed polling that returns "nothing changed", digest-by-
default subscriptions, deduplicated monitor lines (one per workflow/step/effect
with an attempt count), and a subscribe-time error when a filter cannot carry
the event its own reason names.

### RC6 — One call per turn (prompt + tool definition, S)

Roles: `02a F3`, `02b W3`, `02c V5`, `02g RES-4`, `02h` (counter-example).
**Measured:** dataset-wide **48.3 %** of call-recorded turns make exactly one
call; planner 74.2 % of the 59 call-visible runs (1,598/2,153); worker 78 % of
the modern partition (7,328/9,407); verifier single-call turns carry **19.36
units (35 % of the verifier slice)**. The runtime supports batching — 253 turns
carry 4–9 calls, 19 carry 10+, one verifier round made 783 calls in 368 turns —
and the one run that batched seriously had 38 `grep` calls and a 3.2 %
shell-substitution rate.
**Assumption:** merging two independent single-call turns into one removes one
context re-send, not the work; the saving therefore scales with the context
curve (RC2), not with the turn count directly.
**Modelled:** 4 / 9 / 20 units (1.0 / 2.3 / 5.1 %). `02b`'s 35–45 % claim assumes
a 40 % turn cut; I keep the range narrower because batched turns carry more
result tokens per request.
**Recommendation:** put the batching rule in the place it is read — the first
lines of the assignment and the `read`/`grep`/`bash` tool descriptions — not only
in the 17.6 KB protocol document, and A/B it before claiming the large number.

### RC7 — Premium models on mechanical steps (config, S)

Roles: `02a F4/F5/F6`, `02b W1`, `02g RES-2`.
**Measured:** three `core.plan` runs of identical shape (27 turns) at **1.7139**
(`pi-copilot-opus`), 0.0416 and 0.0397 — 41–43×. Two `pi-copilot-opus`
consolidations are 12.9088 of the consolidator's 12.9794 units. Profile
`pi-eon-sonnet` carries **72.348 units over 5 runs**, one of them the 66.38-unit
run. A research session billed $1.6765 for 20 calls against $0.1437 for 145
calls — 11.7× for 1/7 of the work.
**Assumption:** a cheap pool would have produced an equally accepted plan. This
is the one assumption the dataset cannot test (no plan bodies, no accepted-plan
count), so the saving is a **capability to be confirmed by the routing
experiment**, not a booked number.
**Modelled:** 20 / 40 / 70 units (5–18 %) if mechanical steps (planning,
consolidation, triage, wiki drafting, mechanical edits) run on the cheap-medium
pool and the premium pool is reserved for a measured trigger.
**Recommendation:** pin the plan/consolidate/wiki mechanical steps to the
cheap-medium pool; make the classifier's choice visible per step; treat the
1,072-turn run as a bootstrap outlier, not as evidence for the tier.

### RC8 — Retries without change, and loops that never converge (engine, M)

Roles: `02e WD-4/WD-5/WD-7`, `02f F1`, `02b W1`, `02c V6`, `02d T5`.
**Measured:** archive failure tail 168 of 721 turns (23 %) in two runs, both
`attention-required`, one issuing ~40 `openspec` commands for no archive; a push
retried three times in 23 s with nothing changed (SSH `Permission denied
(publickey)`); 121 empty settles + 34 nudges in 17/8 workflows (20 settles inside
112 s in one workflow); one recursive `grep` ran **1,202 s** (41 % of a run)
until the developer aborted it; 42 `operator.repair` events across 23 workflows
that carry **124.64 of 391.02 units (31.9 %)** — a cohort, not a measured
per-repair cost; `core.triage`'s two 96 KiB assignment errors are the workflow's
last recorded words.
**Assumption:** a repair marks a workflow the engine could not finish alone; the
cost is that workflow's re-run, not the repair event.
**Modelled:** 3 / 8 / 20 units (0.8 / 2.0 / 5.1 %) plus the reliability gain.
**Recommendation:** bound the loops (default `bash` timeout, N consecutive
failures with zero successes fails the run, ≤2 archive attempts then `blocked`
with the validator output, preflight push credentials and block once).

### RC9 — `bash` instead of `read`/`grep`/`codemode` (prompt + tool definition, S/M)

Roles: `02a F2`, `02b W5`, `02e WD-3`, `02g RES-4`, `02h ORCH-13`.
**Measured:** planners made **0 `grep` calls** in the whole slice against 1,621
bash and 908 read; wiki 431/718 calls are bash carrying 1.36 MB of 1.79 MB; a
research session did 119 of 130 calls through the shell with no `grep` tool and
no `codemode`; `bash-vs-tools` shows 3.2 %–79.2 % shell-for-a-tool per run. It is
**model-dependent**: every `pi-opencode-go-deepseek-flash` run in the digest set
made 0 `grep` calls, while the `pi-opencode-go-luna` run made 38.
**Assumption:** a bounded `read`/`grep` returns less context than a whole-file
`cat`/`sed`, and `codemode` collapses a search→filter→summarise pipeline into one
turn.
**Modelled:** counted inside RC3 and RC6; no separate number (byte evidence is
too thin — result sizes are missing for 81 % of verifier calls).
**Recommendation:** state the tool surface in the brief for the profile that
actually receives it, and name `read`/`grep`/`codemode` in the assignment's
first line; measure per model profile, because one profile already does it.

### RC10 — Telemetry and measurement defects (telemetry, S)

Roles: `02g RES-1`, `02c`/`02d`/`02b` data limits, `02f F5`, `02d T2/T3`,
`02h ORCH-12`, plus two defects found here.
**Measured:**
- **9 harness stores parsed to 0 rows** ("unreadable: unable to open database
  file") while holding **2,263 assistant turns and 2,803 tool results** — the
  only place in the snapshot with stop reasons, thinking tokens, per-call result
  sizes and argument digests. This is the whole of the +6.7 % turns between the
  pinned build and a repaired one.
- **Attribution drift:** 156 runs in 38 workflows carry turns after their
  recorded completion (max tail 63,380 s); 21 of 86 modern worker runs record no
  turn at all.
- **Decisions unrecorded:** no triage/gate decision since 2026-08-14 (RH T2/T3),
  verifier tool arguments for 2 of 9,226 calls, no round event.
- **Two repair-needed defects in the analysis tooling itself** (found and fixed
  in this step, see the commit): `scripts/efficiency/lib/queries.ts` had lost
  three object boundaries in a merge, silently swallowing `source-gaps`,
  `delivery-timeline` and `run-window-drift` (30 definitions, 27 reachable), and
  `test/efficiency/efficiency-queries.test.ts` had four spliced test bodies, so
  **`bun run type-check` failed on main** and every query assertion added by
  `02b`/`02c`/`02d`/`02h` was unexercised.
**Modelled:** no direct saving. This is the precondition for measuring anything
else; without it the next review is as blind as this one.
**Recommendation:** backlog 2, 8, 9, 10, 11, 20, 22.

## What not to change

Things that look wasteful but carry quality, with the evidence that says so.

1. **The engine-owned single full-suite run per verifier round.** 93 of 121
   rounds ran it once; 1,160 s of recorded bash across 95 runs, largest single
   command 144 s. The waste is the 6 workflows that re-ran it and the missing
   failure classification, not the run.
2. **A zero-finding security or openspec round.** `security-verifier` has the
   worst cost per finding (1.85 over 3) but its briefs say to state plainly when
   a boundary is clean, and its criticals include a real one. Treating "no
   boundary crossing found" as waste would remove the signal that a boundary is
   intact.
3. **`wiki search`/`wiki show` before a write, and `openspec validate` in the
   archive step.** The wiki discovery phase is the anti-duplicate control (3–6
   calls, 26–55 kB per run); the archive brief is the *smallest* asset (1,364 B)
   and its commands are the job. Trim the unbounded part (RC3), not the control.
4. **`developer_question` waits of 65 and 54 minutes.** That is the developer,
   not the agent, and the alternative is guessing. Measure it as human latency;
   never fold it into "agent time".
5. **`pushed → closed` (mean 5.2 min) and `wiki-approval → archive` (mean
   33.3 min, max 221.6 min).** Human latency again; the step *order* is sound
   (archive precedes the push in all 32 workflows).
6. **Reading before writing at all.** A planner must choose a change id and
   author artifacts it has not seen; the first `openspec status` is itself
   orientation. RC3 measures the *size* of the orientation half, not the
   proposition that it should be zero.
7. **The 17.6 KB shared protocol prompt.** Cache-hit rates are 93–99 % per role
   and the median first-turn cache write is only 613–1,137 tokens, so the prefix
   is small and already cached. It is the wrong *place* for the batching rule
   (RC6), not too big.
8. **`codemode` in the 1,072-turn run (667 of 1,192 calls).** It is the batching
   tool, and its 1,058 s total is small. That run's cost is context (RC2).
9. **`mktemp`/`HOME=`/`AGENTIC_CODING_CONFIG_DIR=` prefixes and the
   `biome check --write`/type-check/build invocations.** They are the
   repository's own documented isolation and gates; type-check once and build
   once per change are protocol requirements (10 builds and 17 type-checks over
   5 runs is not a loop).
10. **Repeated full suites after every small edit** are bounded: 13 whole-suite
    invocations against 108 edits, ≈2–6 min per affected run. Worth a nudge,
    not a project.
11. **The global-search guard.** It fired on exactly the expensive class — 9
    blocks in 6 workflows, three of them whole-filesystem `find /` walks, the
    same shape as the 1,202 s grep. Keep it and record what happens next.
12. **The routing and gate classifier passes.** Free local model, ~1.4 s median,
    17.7 s of wall time in the whole snapshot. The problem is the 300 s timeout
    ceiling and the missing decision record, not the pass.
13. **The 8 retried `workspace.setup` effects.** Genuinely retryable
    infrastructure, ~1.3 s of work each; failing the workflow instead is worse.
14. **The 16-hour and 3-day "stalls".** Six agents stalling and resuming within
    seven minutes of each other is a suspended host. What is missing is the
    engine's ability to tell that apart from agent idling (backlog 11).
15. **Three parallel fusion planners (3.28 units).** The parallel drafts are
    nearly free; the money is the consolidator's model (RC7).
16. **`openspec` CLI traffic in planning.** The briefs mandate `2N+4`
    invocations for N artifacts; the observed run made nine for a typical plan —
    fewer than prescribed, with no repeats.
17. **Large single file reads.** The largest recorded planner read is 21,946 B;
    the 10 `App.tsx` slices in the research session are bounded ranges whose
    overlaps total ~31 lines. There is no evidence of whole-file reads where a
    range would do.

## Measurement plan

One query, `kpi-baseline` (added in this step as an append-only entry in
`scripts/efficiency/analyze.ts` with a test), prints the board below. Baselines
are from the pinned build.

| KPI | baseline | query |
| --- | --- | --- |
| cost total (preferred) | **391.0161** | `kpi-baseline` |
| share of cost after 2026-08-31 | **0.1948** (a cost-coverage warning, not a trend) | `kpi-baseline` |
| runs / turns / tool calls | 1,238 / 33,137 / 25,024 | `kpi-baseline`, `summary` |
| single-call turn share | **0.483** | `kpi-baseline`, `calls-per-turn` |
| verifier cost share | **0.1414** | `kpi-baseline`, `roles` |
| worker turns per run | **106.8** | `kpi-baseline`, `roles` |
| runs with every call failed per 1,000 (≥3 calls) | **201.3** — cannot be read without the era split; post-2026-09-01 it is 0 for verifiers | `source-recording`, `kpi-baseline` |
| blocked handoffs | **18** (1 Sep, 17 Oct) | `kpi-baseline`, `handoffs` |
| empty settles / workflows | **155 / 17** | `kpi-baseline`, `events` |
| developer questions | **44** | `kpi-baseline` |
| cold-cache turns and their cost | **81 turns, $28.78 (write)** in one conversation; corpus-wide blocked by missing `cache_write_tokens` | `cache-expiry` |
| turns above 100 k context, and their cost | **1,136 / 11.7329 units** (verifiers) | direct SQL or `roles` |
| pre-first-artifact cost share | planner `core.plan` **0.507**, wiki **0.66** | `orientation-cost` |
| pre-first-edit calls and bytes | **38.3 % of calls, 99 KB/run** in the 59 runs above 20 calls | `edit-latency` |
| shell-for-a-tool share | 3.2 %–79.2 % per run (digest-visible only) | `bash-vs-tools` |
| rounds ≥2 cost as a share of round 1 | **7.198 vs 48.087 units (15 %)** | `verifier-rounds` |
| roles per round | 87 % of rounds ≤4 roles | `verifier-rounds` |
| run-window drift | **156 runs / 38 workflows**, max tail 63,380 s | `run-window-drift` |
| source files that parsed to 0 rows | **9** | `source-gaps` |
| build totals (the denominator itself) | 1,238 runs / 33,137 preferred turns / 25,024 calls / 391.0161 units | `summary` |
| cost per merged change | **not computable** — the dataset has no change identity | needs a new join (backlog 20) |
| result bytes per orchestrator turn | not in the dataset (harness gap) | needs backlog 22 + an attribution step |
| agent time vs developer wait | not computable — no `workflow.waiting` event | backlog 11 |

How to extend it: add one `kpi-*` query per board row that is still missing,
append-only in `queries.ts`, with a test in
`test/efficiency/efficiency-queries.test.ts`; run the focused suite isolated with
`HOME`, `AGENTIC_CODING_CONFIG_DIR` and `HERDR_WIKI_DIR` set to temp directories.
Then re-run the three reviews that are cheapest to repeat (`roles`,
`orientation-cost`, `verifier-rounds`) on the next snapshot and compare against
the baselines above.

## Assumptions this document rests on

1. The pinned dataset build is the reference; preferred rows define every
   denominator. Where a report used the all-rows count (33,537) I state the
   preferred one (33,137) and the 400-row difference.
2. The cost column is computed list price (RC unit section). Nothing here says
   what was actually billed.
3. Transcript-only findings (`02h`, `02f`, `02g`) were re-read from the raw
   harness stores directly, because the dataset's harness reader is broken
   (RC10/backlog 22). `02h`'s numbers reproduced to the cent; `02f`/`02g` were
   not re-measured.
4. Every "reclaimable" figure is modelled from the measured waste it sits in; the
   measured column is the trustworthy one. Money, developer time and reliability
   are reported separately and never added together.
5. Repairs to `scripts/efficiency/lib/queries.ts` and
   `test/efficiency/efficiency-queries.test.ts` in this step are analysis
   tooling, not product code: they restore three swallowed queries and make the
   focused suite and `bun run type-check` pass on a tree where they did not.
