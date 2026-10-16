# Efficiency deep dive 2h — the orchestrator conversation

Scope: the Home orchestrator agent — the one role with a full transcript over a
long horizon. Everything below is measured from the snapshot's raw
`orchestrator/harness.sqlite` (conversation 2) and from the product source as
context for *why* it behaved that way. No transcript text, tool arguments or
tool results are reproduced here; ids, counts and byte sizes only.

## Summary

The slice is 570 assistant turns, 480 tool calls and 165 user-role entries over
193 h of wall clock, costing **$48.13** (297 k output tokens, 65.68 M cache-read
and 12.81 M cache-write tokens) on `github-copilot/claude-sonnet-5.5`.

Cost decomposes as **cache write $32.03 (66.6 %), cache read $13.14 (27.3 %),
output $2.97 (6.2 %)**. Only **5.0 %** of those written tokens are content that
was actually new to the conversation; 95 % of the write cost is the model
re-writing a prefix it already had. The top findings, with the share of the
$48.13 they explain:

| # | Finding | Measured impact | Share |
| --- | --- | --- | --- |
| ORCH-1 | Prompt cache expires across idle gaps; the cold turn re-writes the whole prefix at 12.5× the read rate | $29.82 on 85 turns (14.9 %) preceded by a >5 min gap; 57 of them by >10 min | 62.0 % |
| ORCH-2 | `workflow_status` returns the full task text and duplicates its question list | 86 calls / 431,688 B; task 201,039 B (47 %), `orchestratorQuestions` a byte-identical copy of `pendingQuestions` in 30 of 77 calls (12,278 B) | 23.6 % |
| ORCH-3 | `list_workflows` returns every workflow with its full task text every call | 21 calls / 262,726 B; task 153,582 B (58 %); largest result 51,245 B | 10.8 % |
| ORCH-4 | Polling that changes nothing | 86 `workflow_status` calls for ~30 workflows; 38 monitor-triggered turns whose only call was `workflow_status` ($9.07) | ~19 % |
| ORCH-9 | Automatic compaction never fires; all four compactions were manual | window 1,000,000 → trigger 700,000; peak context 330,458; capping at 150 k would save $8.30 | 17.2 % (counterfactual) |
| ORCH-5 | 58 of 479 calls failed (12.1 %): `read` 24/41 (58.5 %), `start_workflow` 12/54 (22.2 %) | 22 ENOENT probes, 8 dirty-worktree refusals (two back-to-back) | ~5 % + rework |
| ORCH-1′ | A 1 h prompt cache would have made 63 gapped turns warm | modelled $27.76 instead of $48.13 | up to 42 % |

The two levers that matter are *how big the prefix is* and *how often it is
re-written from cold*. Tool-output shaping alone is worth about $8.80
(ORCH-2/3/12); killing the cold re-writes is worth up to $20.38 but depends on
a provider capability the model catalog does not currently declare for this
model.

## Slice and method

**What is in the slice.** One conversation: the orchestrator harness store,
conversation 2, 1,225 entries — 570 `pi.assistant`, 479 `pi.tool-result`, 165
`pi.user` (86 of them `[workflow-monitor]` notes, 79 developer messages), 4
`pi.compaction` and 7 `pi.system` — 480 tool calls of which 58 reported an
error. The conversation was not attributed to a durable run (a known gap of the
snapshot), so it joins to nothing else and stands on its own.

Slightly larger than the brief's figures (≈525 turns, 437 calls, 56 failures,
58 M cache reads, ~45 units): the re-snapshot at 2026-10-16T12:35Z added turns.
The numbers here are the current snapshot.

**Method.**

1. Normalised the store into per-turn and per-call records (`toolName`,
   `arguments`, usage counters, stop reason, timestamps) plus the matching tool
   results, hashing arguments for exact-repeat detection. Argument and result
   *text* never left the scratch directory.
2. Calibrated bytes→tokens against the recorded counters: the conversation
   carries **≈2.5 bytes per token** consistently (turn 1: 8,040 B / 2,888
   tokens; turn 200: 530,733 B / 212,332) — JSON is dense, so any byte-based
   estimate that assumes 4 B/token understates context cost by ~40 %.
3. Attributed cost per item class exactly: at each turn the charge
   (`cache_write×$2.5/M + cache_read×$0.2/M`) is spread over the items actually
   present in the prefix at that turn, with presence bounded by the next
   compaction. The attribution reproduces the recorded $45.16 write+read
   exactly, plus $2.97 of output.
4. Read the raw transcript for the largest and the typical runs to judge
   usefulness: I inspected the argument and result *shapes* (never the text) of
   every call of the ten purpose-built tools, sampled the three largest
   `workflow_status`, `list_workflows`, `list_agent_config` and `bash` results,
   and walked the failure set and the user-entry stream to see what the
   developer had to repeat.
5. Cross-checked the tool contract against `src/agent-host/orchestrator.ts`,
   `src/workflow/compaction.ts`, and the model catalog the host resolves at
   runtime (`@earendil-works/pi-ai` provider data).

**Coverage limit of the slice.** This is *one* conversation and one developer's
usage pattern (a long-lived Home session driving many short workflows
sequentially). The per-tool percentages are the orchestrator's; they do not
transfer to a workflow worker, whose transcript does not exist in the snapshot.

## Findings

Ranked by estimated cost. "Attributed" is the share of the conversation's $45.16
of write+read cost that class of item accounts for.

| id | finding | evidence | quantified | conf. | kind |
| --- | --- | --- | --- | --- | --- |
| ORCH-1 | Cold-cache prefix re-write | turns 256/258/264/266/268: `cacheRead` exactly 0 with `cacheWrite` 300,747–318,254 after 642–1,490 s gaps | $29.82 (62.0 %) on 85 turns; 11.51 M of 12.81 M written tokens | high | config |
| ORCH-1′ | 1 h prompt cache | modelled from the same turns | $48.13 → $27.76 (saves $20.38) | medium | config |
| ORCH-2 | `workflow_status` output shape | 86 calls, 431,688 B; entries 1631 (19,931 B: task 6,005 B + two identical 5,886 B question arrays), 1921 (18,414 B: task 11,340 B) | attributed $10.65; −$5.00 task, −$0.30 duplicate | high | tool |
| ORCH-3 | `list_workflows` output shape | 21 calls, 262,726 B, 83 items, 2 empty results; largest 51,245 B | attributed $4.86; −$2.82 task text | high | tool |
| ORCH-4 | Polling that changes nothing | 86 `workflow_status` for ~30 workflows; one polled 7× (turns 350–393), another 6× (16–26) | 38 turns only polled ($9.07) | high | engine |
| ORCH-5 | Failed calls | 58/479; `read` 24/41, `start_workflow` 12/54, `workflow_status` 9/86, `bash` 12, `workflow_action` 1 | 22 ENOENT + 2 EISDIR; 8 "working tree must be clean", two consecutive (entries 1798/1799) | high | tool |
| ORCH-6 | System prompt + tool definitions re-sent every turn | first system entry 963 B + 4,704 B for 10 tools; last 4,572 B + 17,072 B for 16 tools | attributed $2.70 (6.0 %); prefix grew 5.7 kB → 21.6 kB | high | tool |
| ORCH-7 | The full task text is re-typed into every `start_workflow` call | 54 calls, 163,957 B of arguments, 153,081 B (93 %) in `task`; 44 distinct ids for 54 calls | output-rate + re-carry; 11 repeated task prefixes | medium | tool |
| ORCH-8 | The assistant's own output is re-carried | 257 kB of visible text over 176 turns (max 5.2 kB), 131 kB of thinking | attributed $11.96 (26.5 %) | high | prompt |
| ORCH-9 | Auto-compaction is inert | window 1,000,000; trigger = window − max(32,000, 30 % of window) = 700,000; peak 330,458; all 4 compactions `reason: "manual"` | cap at 150 k saves $8.30; at 200 k $3.39; first turn over 150 k is 139 | high | config |
| ORCH-10 | Monitor notes | 86 of 165 user entries; 45 of their turns were cold; 20 made no tool call, 38 only polled | $19.03 on their turns; a 5-min digest collapses 26 notes ($0.82) | medium | engine |
| ORCH-11 | The orchestrator's own mistakes | subscriptions created with `minSeverity` too high to carry the completion the reason named (entries 2169, 2276); the developer had to say the step finished unannounced (entry 2329, turn ~557) | direct ~$1.0; correctness worse than cost | medium | tool |
| ORCH-12 | Pretty-printed JSON | `list_agent_config` 20,607 B raw vs 12,406 B compact → 8,201 B of indentation (40 %); `list_workflows` 4-space indent | −$0.68 measured on `list_agent_config` | high | tool |
| ORCH-13 | `bash` as the search tool | 248 calls, 549 kB of output (git 52, grep 47, ls 33, sed 32, python3 14, sqlite3 8) | attributed $4.41 (9.8 %) | high | tool |

### ORCH-1 — the dominant term is cache expiry, not tool output

The provider caches the prompt prefix. When the cache is warm a turn reads
65–210 k tokens at $0.20/M; when it has expired the same tokens are *written*
again at $2.50/M. The recorded counters show the boundary exactly: every turn
preceded by a gap under ~5 minutes has `cacheRead` ≈ the full context, every
turn preceded by a longer gap has `cacheRead` = 0 and `cacheWrite` = the full
context. The model entry for `github-copilot/claude-sonnet-5.5` declares no
`promptCache` block, so the short (300 s) TTL applies; `claude-fable-5` in the
same catalog declares `{short: 300, long: 3600}`.

Bucketed by the gap before the turn:

| gap | turns | idle | cache write | cache read | cost | write $ | read $ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <10 s | 322 | 22 min | 0.71 M | 43.5 M | $12.38 | $1.77 | $8.70 |
| 10–60 s | 109 | 41 min | 0.41 M | 14.9 M | $4.62 | $1.01 | $2.98 |
| 1–5 min | 54 | 130 min | 0.18 M | 6.9 M | $2.01 | $0.46 | $1.38 |
| 5–10 min | 28 | 202 min | 3.69 M | 0.4 M | $9.43 | **$9.23** | $0.08 |
| >10 min | 57 | 11,193 min | 7.82 M | 0.0 M | $19.70 | **$19.56** | $0.00 |

85 turns (14.9 %) sit in the bottom two rows and carry 60.5 % of the
conversation's cost. This is *not* the agent working: total inter-turn time is
11,588 min for 570 turns, of which 11,395 min is a gap over 5 min — i.e. ~99 %
of the wall clock is the developer being away, and the agent's own turnaround
(sum of all gaps under 5 min) is 193 min, about 20 s per turn. The expensive
turns are the *first* turn after the developer comes back.

Counterfactual with a 1 h TTL (write rate 2.5 → 4.0 $/M, cache survives 1 h of
idle): $27.76 instead of $48.13. This is an upper bound and it depends on the
provider exposing the long TTL for this model — hence medium confidence on
ORCH-1′, high on ORCH-1.

### ORCH-2 / ORCH-3 / ORCH-12 — the tool-output shape

`workflow_status` is the orchestrator's main instrument (86 calls) and its
result is large because it embeds prose that does not change between polls:

* `task` — 201,039 B of 431,688 B across the calls that parsed. One 19,931 B
  result carried 6,005 B of task text; an 18,414 B result carried 11,340 B.
* `orchestratorQuestions` and `pendingQuestions` are emitted as two arrays with
  identical contents in 30 of the 77 parsed calls (12,278 B of literal
  duplication). `summarizeWorkflowView` in `src/agent-host/orchestrator.ts`
  copies both through from the server view; a question routed to the
  orchestrator is therefore in both lists.
* `runs` (53,822 B) and `gateDecisions` (20,243 B) are history that is
  re-sent on every poll.

`list_workflows` returns the whole board each time: 83 workflow entries over 20
parsed calls (max 14 per call), 58 % of the bytes being the same task prose, in
pretty-printed JSON, and two of the 21 calls returned an empty array.

The tool-level cap is `MAX_RESULT_CHARS = 60_000` in
`src/agent-host/orchestrator.ts`. The largest result observed was 51,245 B, so
**the cap never bound** — the waste is field selection, not truncation.

Attribution: `workflow_status` $10.65 (23.6 %), `list_workflows` $4.86 (10.8 %),
`list_agent_config` $1.71 (3.8 %), `list_branches` $2.93 (6.5 % for three
identical 12.6 kB calls early in the longest segment), `list_projects` $0.82.

### ORCH-9 — automatic compaction never fires

The policy resolves `reserveTokens = max(32,000, 30 % of the run's window)`
(`src/workflow/compaction.ts`), and this model declares a 1,000,000-token
window, so the blocking threshold is 700,000 tokens and background compaction
starts at 668,000. The conversation peaked at 330,458 tokens (turn 280) — 33 %
of the window, 47 % of the trigger — and the four compactions that did happen
all carry `reason: "manual"`. Under the *old* absolute default (32,000) the
trigger would have been 968,000: also never reached. So the choice between the
old and the new default is academic for this conversation; the real statement is
that a window-relative reserve sized for *overflow safety* is not a
*cost* control on a 1 M window, and the developer compacted by hand at 330 k,
215 k, 140 k and 100 k tokens — progressively earlier, which reads like cost
tuning by feel.

Modelled saving from holding the context at a lower ceiling, other things equal:
$8.30 at 150 k (first exceeded at turn 139), $3.39 at 200 k, $1.38 at 250 k.
213 of 570 turns were above 150 k tokens.

### ORCH-4 / ORCH-10 / ORCH-11 — polling, notes, and the agent's own mistakes

86 `workflow_status` calls cover about 30 distinct workflows; the polls cluster
after monitor notes. Of the 86 turns that immediately follow a
`[workflow-monitor]` note, **20 made no tool call at all** and **38 made only a
`workflow_status` call**; together 58 of 86. Their cost ($4.21 and $9.07) is the
cost of being woken to do nothing. But the metadata is smaller than the
context: the notes themselves total 17.3 kB and a 5-minute digest would collapse
only 26 of them ($0.82). The reason those turns are expensive is ORCH-1 — the
note arrives after the gap that killed the cache.

The orchestrator then made it worse itself: its own subscriptions used
`minSeverity: "warning"` (entries 2169, 2276) although the stated reason for
each subscription was to learn when the run *finishes, blocks or fails*. A
successful completion is below `warning`, so no note arrived; the developer had
to report that the step finished unannounced (user entry 2329), after which the
orchestrator pulled the events by hand (entries 2332, 2340) — two extra calls,
an extra cold turn at $0.51 (turn 557), and a lost trust signal. The tool
description in `src/agent-host/orchestrator.ts` documents the severity
mechanism; the failure is that a filter which cannot deliver the event the
reason names is accepted silently.

`start_workflow` was called 54 times for 44 distinct workflows; 12 were refused,
8 of them with "working tree must be clean before workflow start", and two of
those refusals are consecutive entries (1798, 1799) — a retry with nothing
changed. `read` failed 24 times out of 41, 22 of them ENOENT: the orchestrator
guessed `openspec/changes/<id>/proposal.md` paths in five different repositories
before finding one. The wrong-id polls (`add-environment-instances` versus the
real `add-environment-instance-lifecycle`, `research-ui-lag` versus
`fix-ui-lag-main-thread-work`) share one cause: `list_workflows` and
`workflow_status` do not agree on a single identifier the orchestrator can carry
between them, and the orchestrator had no primitive that says whether a path or
a workflow id exists.

### ORCH-6 / ORCH-7 / ORCH-8 / ORCH-13 — what else the prefix carries

* Prompt and tool definitions: 5,667 B at the start (10 tools) growing to
  21,644 B (16 tools) by entry 2087. Attributed $2.70 — small, but it is
  re-charged on all 570 turns, so every 1 kB of tool description costs ~$0.13
  per conversation.
* `start_workflow` arguments: 164 kB written by the model, 93 % of it the `task`
  field. Output tokens are charged at $10/M and the text is then carried for the
  rest of the conversation, so re-typing a task the developer already wrote is
  paid for twice over.
* Assistant output: $11.96 attributed. Median visible message 1.2 kB, max
  5.2 kB, so the orchestrator is not chatty per message; the class is expensive
  because there are 570 turns and 296 of them carry thinking blocks.
* `bash` is the only search primitive: 248 calls, 122 of them grep/ls/sed/cat/find,
  549 kB of output, attributed $4.41. Median bash result 1.2 kB, so the calls
  are individually cheap; there are simply many of them and each result stays in
  the prefix.

## Justified (looked expensive, is not)

* **The event-subscription family.** `subscribe_events`, `read_events`,
  `list_subscriptions` and `sessions_report` cost $0.08 of context combined
  (8 calls, 12.7 kB). Push subscriptions replace polling and are the cheapest
  thing in the slice.
* **The 60,000-char result cap.** The largest result was 51,245 B, so it never
  truncated anything. It is not the problem — and removing it would not help.
* **`bash` for search.** The orchestrator has no dedicated search tool, so
  `grep -rn` through `bash` is the only available path; per-call output is
  bounded and mostly necessary. The cost is the accumulation, not the calls.
* **`read` as a tool.** Median read result 159 B, largest 5.6 kB. The tool is
  cheap; the 58 % failure rate is a path-guessing problem (ORCH-5), not a read
  problem.
* **Thinking tokens.** 131 kB over 296 turns. Small enough that no measurement
  here justifies touching them.
* **Compaction itself.** The four summaries are 10.2–15.1 kB each; the cheap
  part of the conversation. Only the *trigger* is worth changing.
* **Turn batching.** 55 of 570 turns made 2+ calls in one message (one made 13),
  348 made exactly one and 167 made none. Given the workload — a status check, then a single
  action — there is no evidence of batching left on the table.
* **The wall-clock idle.** 11,395 of 11,588 inter-turn minutes are gaps over 5
  minutes. That is the developer, not the agent; agent turnaround is ~20 s per
  turn.

## Data limits

1. **The rebuilt dataset contains no harness transcripts at all — a tooling
   defect, not a gap in the snapshot.** All 9 harness files record
   `0 conversation(s); unreadable: unable to open database file`, so
   `turns`/`tool_calls` hold no `harness.*` rows. Root cause:
   `scripts/efficiency/lib/harness.ts:253` opens with
   `new Database(filePath, { readonly: true })`, and every `harness.sqlite` is a
   WAL database (header read/write version 2) with no `-shm` file in the
   snapshot, which SQLite refuses to open read-only (`SQLITE_CANTOPEN`).
   `file:<path>?immutable=1` opens the same file; `herdr.db` and
   `traces.sqlite` are rollback-journal databases (version 1) and parsed
   normally (228 and 62,511 records). Consequence: the counts in
   `docs/efficiency/00-data-inventory.md` (34,820 turns, 27,077 tool calls,
   3 workflows with "full (transcript + args)" coverage) do not match the
   rebuilt dataset (33,537 turns, 25,504 calls, 0 such workflows). Every
   per-role total in any step of this review is a lower bound, and any step that
   relied on the dataset for transcripts analysed nothing. This report was
   produced from the raw store instead.
2. The snapshot's harness file list also changed since the inventory doc was
   written (it now has `worktrees/efficiency-step-1-dataset` and
   `worktrees/fix-event-bus-missed-transitions`).
3. The orchestrator conversation is not attributed to a durable run, so it
   cannot be joined to `herdr.db` rows or to engine events; the surrounding
   engine's contribution is invisible from here.
4. No per-call or per-turn durations: wall time is reconstructed from entry
   timestamps only, and an assistant timestamp is the response time, not the
   turn start. Gaps therefore mix developer think-time, tool time and idle.
5. `cache_write_tokens` is NULL on 7,495 of 13,049 `telemetry.main-store` turns,
   so the corpus-wide `cache-expiry` query undercounts; the harness rows used
   here are complete.
6. The effective agent/compaction configuration for this conversation is not in
   the snapshot; the defaults were read from `src/workflow/compaction.ts` and the
   window from the pi-ai catalog. If the user had configured a compaction
   section, the ORCH-9 reading changes.
7. Developer messages are readable but carry no signal about how long the
   developer spent reading; I used them only to see *what* had to be said again.

## Recommendations, ranked by expected saving per effort

| rank | recommendation | kind | expected saving | effort | how to verify |
| --- | --- | --- | --- | --- | --- |
| 1 | Keep the orchestrator's context small: a cost-aware ceiling for long-lived Home sessions (roughly 100–150 k tokens) instead of a window-relative reserve sized for overflow | config | $8.30 of $48.13 measured at a 150 k cap; more as the conversation grows | low | re-run `analyze.ts cache-expiry` and `context-growth` on the next long session; the target is the cache-read share of cost rising and peak input falling |
| 2 | Use (or ask the provider for) the long prompt-cache TTL for the models the orchestrator runs on, and declare it in the catalog | config | up to $20.38 (42 %) if the 1 h TTL is available; certain part ≈ $9.2 (the 5–10 min bucket) | low | `analyze.ts cache-expiry`: the 5–10 min bucket's cache_write must collapse toward its cache_read |
| 3 | Shape `workflow_status` output: drop or gate `task`, stop emitting `orchestratorQuestions` when it duplicates `pendingQuestions`, cap `runs`/`gateDecisions` behind a flag | tool | $5.30 (task $5.00 + duplicate $0.30) | low | per-tool result bytes in `tool_calls` and the same attribution; target < 4 kB median per `workflow_status` |
| 4 | Give `list_workflows` a compact default row (id, target, status, step, attention, branch) and make the task text opt-in; return compact JSON | tool | $3.50 ($2.82 task + part of the $2.93 `list_branches`/indent) | low | same measurement; median result should fall from 6.1 kB to ~2 kB |
| 5 | Emit compact JSON from every orchestrator tool (`list_agent_config` is 40 % indentation) | tool | $0.68 measured on the smallest instance; applies to all three list tools | low | result bytes per tool before/after |
| 6 | Make wake-ups cheaper and rarer: default orchestrator subscriptions to `digest`, and let a no-op note be absorbed without a turn | engine | $4.21 (20 no-op turns); note-level collapse adds $0.82 | medium | monitor notes per hour and the cost of turns that follow them |
| 7 | Return a "nothing changed" answer: `workflow_status` keyed on `revision` (already returned) and multi-id capable, so a poll that finds no change is a few bytes | tool | up to $9.07 (the 38 poll-only turns) | medium | `repeated-calls` on `workflow_status` plus result bytes |
| 8 | Let `start_workflow` take a task *reference* (an openspec change path, or the previous message) instead of a re-typed task, and report the dirty paths on a "working tree must be clean" refusal | tool | 153 kB of re-typed prose per session, plus 8 avoidable refusals | medium | `args_bytes` on `start_workflow`; refusal count |
| 9 | Add an existence/listing primitive for a repository's changes (and align the workflow identifier `list_workflows` returns with the one `workflow_status` accepts) | tool | 22 ENOENT + 2 EISDIR failures, ~5 % of calls | medium | `failed-chains` for `read` and `workflow_status` |
| 10 | Make a subscription whose filter cannot carry the event its own `reason` names a visible error, not silence | tool | ~$1 direct; prevents the trust failure that cost a developer round-trip | low | a test that a `minSeverity` above a completion event's severity is reported at subscribe time |
| 11 | Trim orchestrator tool descriptions (prefix grew 5.7 kB → 21.6 kB for 10 → 16 tools) | tool | $0.13 per kB per session | low | the `system+tools` class in the attribution |
| 12 | Fix `scripts/efficiency/lib/harness.ts` to open WAL stores (`file:…?immutable=1`, or copy before opening) | engine | no direct saving; it restores the only per-turn/per-call data every other step of this review depends on | low | rebuild the dataset and check that `harness.*` rows appear in `turns`/`tool_calls` and that `analyze.ts coverage` reports `has_transcript` |

## Open questions

* **Does the provider expose the 1 h cache for `claude-sonnet-5.5`?** The
  catalog entry declares no `promptCache` block while `claude-fable-5` declares
  `{short: 300, long: 3600}`. Without that answer ORCH-1′ stays an upper bound.
  Everything in ORCH-1 itself is measured.
* **Is manual compaction a preference or a workaround?** All four compactions
  are manual and arrive progressively earlier; nothing in the snapshot shows a
  configured rule or a developer statement of intent.
* **What caused the 8 dirty-worktree refusals?** The transcript shows the
  refusals but not the working tree, so I cannot say whether the developer
  intentionally left changes uncommitted or an earlier step failed to commit.
* **How much of the 11,395 min of idle is the developer away versus the shell
  idling?** The store timestamps the agent's entries, not the shell's state.
* **Do these proportions hold for the other two transcripts** (the wiki host and
  the backend env-setup author)? They are short, so the re-entry term will be
  much smaller and the prompt-overhead term relatively larger; nobody has
  measured them from the raw stores.
* **Would shrinking the prefix actually reduce provider-side cost?** The write
  cost is charged per token of the prefix, but some providers round cache
  segments; the model here reproduces the recorded total to the cent, which is
  the best available check.

## Artefacts and reproducibility

* New reusable query `cache-expiry` in
  `agentic-coding/scripts/efficiency/lib/queries.ts`, with a test in
  `agentic-coding/test/efficiency/efficiency-queries.test.ts` (buckets are
  disjoint and ordered, every bucketed turn has a measurable gap, and the buckets
  account for exactly the gaps `turn-gaps` reports). Run it with
  `bun run scripts/efficiency/analyze.ts cache-expiry --dataset <dir>`.
* The per-class attribution described above is not committed as a query: it
  needs the harness entries (bytes per item), which the dataset does not carry
  until the harness reader is fixed. The shape to add afterwards is a
  `result-reentry` query joining `v_tool_calls` to `v_turns`: for each tool,
  `SUM(result_bytes × turns after the call within the run)`, bounded by
  compaction events.
