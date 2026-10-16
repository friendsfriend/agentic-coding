# Efficiency deep dive 2g — research and debug

Scope: the two roles with no durable work of their own — the interactive
`researcher` session and the `debug` family — plus the environment tool surface
they share with `env-setup`. Measured from the snapshot's raw
`wiki-workflows/harness.sqlite` (conversations 2 and 463), `backend/harness.sqlite`,
the herdr stores' `debug_requests`/`workflow_runs` tables, and the normalised
dataset; the product source (`agent-definitions/instructions/research.md`,
`instructions/debug.md`, `definitions/graphs/{research,debug}.ts`) is context for
*why*. No transcript text, tool argument or tool result is reproduced here; ids,
counts, byte sizes and short error strings only.

## Summary

The slice is **2 research runs, 101 turns, 165 tool calls, $1.8201 and 35 min of
wall clock** — **0.41 %** of the snapshot's $443.22 — and **zero debug runs**.
Everything below is either a property of one of those two sessions, the state of
the debug feature, or the environment tools it depends on. With n=2 the cost
findings are not a population statement.

| # | Finding | Measured impact | Confidence |
| --- | --- | --- | --- |
| RES-1 | The pinned dataset lost **every** harness transcript: 9 `harness.*` files parsed to 0 rows, so the whole researcher slice is unreachable from it. A rebuild against a writable copy adds 2,263 turns and 2,804 calls (6.7 % / 11.0 % of preferred rows) | the slice's only transcripts, and every stop reason, thinking token, result size and argument digest in the snapshot | high |
| RES-2 | One research run cost **11.7×** the other while doing **1/7** of the calls, on a model **84×** more expensive per call: $1.6765 / 20 calls (`claude-opus-5.5`) vs $0.1437 / 145 calls (`deepseek-v4.1-flash`) | 91.8 % of the slice's cost in 12 % of its calls; 41.9 % of it cache-write, 39.3 % output | high (numbers), medium (cause) |
| RES-3 | **49.5 %** of all result bytes in the readable session came back from a file the session had already touched: 65 of 145 calls, 177,884 of 359,319 B. One file was read in 10 slices (49,903 B = 50 % of all `read` bytes) and also grepped 4× and sed'ed 8× | ~0.5 of the session's context; the opus session scores 3.1 % on the same measure | high (bytes) |
| RES-4 | 119 of 130 shell calls are text probes (`grep` 52, `sed` 36, `cat` 13, `ls` 10, …); `read` was used 15 times, no `grep` tool and no `codemode` at all, in either session | 1.63 calls/turn, 4th of 27 roles (worker 0.84, planner 0.79): each probe is a whole turn | medium-high |
| RES-5 | Turn wall time triples over the 81-turn session with no compaction: 6.4 s/turn (turns 0–19) → 19.2 s (60–80); context 15.6 k → 177 k tokens; the last 41 turns take 72 % of the 17.2 min | 750 of 1,034 s | high (numbers), medium (cause) |
| RES-6 | Neither brief sets a budget or a stopping rule: `research.md` has none at all (the session stays open until the developer closes it); `debug.md` has a stop (report, or `blocked` when unreproducible) but no cost limit | the engine has no lever on an open-ended research session | high (prose) |
| RES-7 | The debug surface has **never been exercised**: 0 runs with role/step/workflow `debug`, 0 rows in `debug_requests` in all three stores, 0 `browser_*`/`http_request`/`evidence_attach`/`debug_*` calls. The 28 calls to the shared env/debug tools (27 of them from `env-setup`) failed **8/28 (28.6 %)**, each retried | the planned grid-allocation-backend E2E run would be the first use of tools whose observed failure modes are below | high |
| RES-8 | The change that added the debug feature (`add-debug-subagent-requests`, 19 runs) spent **1 h 48 m of 3 h 45 m parked** (48 %) after a `blocked` handoff; its two developer questions were answered within 63 s | engine/task-shape overhead, not agent work | high (timings) |

**On the brief's figures.** The stated slice (2 runs, 101 turns, ~1.8 cost units)
reconciles exactly with the dataset. The sessions-report figure it quotes — "20
tools across 20 turns = 1.0 tools/turn at 1.68 cost for one run on the
pi-opencode-free profile" — is the second run (20 turns, 20 calls, $1.6765), but
the snapshot bills **all** of it to `github-copilot/claude-opus-5.5` and
**0.00** to the free pool; turn 0 errored on `opencode/space-bunny-free`
(`stop_reason = error`, 0 tokens) before the session continued on opus. The
profile attribution is wrong, or "profile" there means the launch preset rather
than the model that produced the work.

## Slice and method

**What is in the slice.**

- `research-ui-lag` / run `6c5dafd7-…`, `wiki-workflows` conversation 2
  (`researcher-d2313121`), 2026-10-13 06:41:57→06:59:11. 81 turns, 145 calls
  (130 `bash`, 15 `read`), `deepseek-v4.1-flash` (opencode-go), **$0.1437**,
  514,122 input / 73,741 output / 7,437,568 cache-read / **0** cache-write
  tokens, 0 compactions. Assignment: a 6-part TUI-lag investigation (render path,
  timer inventory, main-thread work, recent-feature census, measurement, ranked
  fixes).
- `research-email-verification-bounce` / run `b67b369a-…`, conversation 463
  (`researcher-0400054b`), 2026-10-14 12:15:07→12:23:49. 20 turns, 20 calls (19
  `bash`, 1 `write`), `claude-opus-5.5` (github-copilot), **$1.6765**, 40 input /
  32,946 output / 1,578,348 cache-read / 140,344 cache-write tokens. Assignment: a
  production email-verification-bounce investigation against
  `grid-allocation-backend`.
- Debug: the `debug` family manifest and `debug.md`, the `debug_requests` table
  in all three herdr stores, every run row with `debug` in role/step/workflow,
  and the 19 runs of `add-debug-subagent-requests` (the change that added it).
- The environment tool surface the debug role is told to use (`env_*`, `db_query`,
  `otel_query`, `browser_*`, `http_request`, `evidence_attach`): 28 calls.
- Adjacent but counted, not analysed: `research-pi-durable` (2026-10-02, 3 runs,
  149 turns, 165 calls, $0.0808) is an implementation workflow whose name merely
  contains "research"; `introduce-research-workflow` is a telemetry file with no
  rows.

**Coverage limits, stated up front.** The wiki host has no durable store in the
snapshot, so research workflows exist only as the two assignment texts and one
written artifact path — no events, gates, handoffs or review of their output.
Two runs, one machine, one week: this is a case study, not a sample. There is no
debug run at all, so the debug findings are inference from the brief, the graph
and other roles' use of the same tools.

**Method.**

1. Pinned dataset first
   (`~/agentic-coding-efficiency-evidence/latest/dataset/dataset.sqlite`,
   read-only). It contains **no harness rows at all** (RES-1), so the slice's
   turns, calls, argument digests and usage counters were not reachable there.
2. Diagnosed that: all 9 `harness.*` `source_files` rows carry `parsed = 0` with
   the note `unreadable: unable to open database file`, although the files exist
   and `file(1)` calls them valid SQLite. Every harness store is a WAL-mode
   database copied without its `-wal`/`-shm`; `readHarness` opens
   `new Database(path, { readonly: true })` (`lib/harness.ts:253`), and a
   read-only open of a WAL database without its shared-memory file fails with
   `SQLITE_CANTOPEN`, which the reader degrades to a note. Creating the `-shm`
   once (or `PRAGMA journal_mode=DELETE` on a copy) makes the same file readable.
3. Rebuilt a second dataset with the repository's own builder against a
   *repaired copy* of the snapshot in a scratch directory, to quantify the loss
   and to read the slice with the same normalisation the other deep dives use.
   The pinned dataset was never modified.
4. Read both conversations with `lib/harness.ts` (turns, per-call arguments,
   result bytes, per-turn usage) and the short error strings of the failing
   environment calls; read the raw `pi.usage` document for each conversation as
   the authoritative per-model cost.
5. Verified the surprising durations: in the harness source
   `tool_calls.duration_ms` equals *the next turn's start minus this call's
   start* (turn 59: 151,289 ms vs a 151,310 ms turn delta; turn 79: 85,467 vs
   85,488), i.e. it is turn wall time attributed to the tool, **not** tool
   execution time. Any "bash is slow" reading from a harness source is wrong.
6. Produced the reusable query `source-gaps` (append-only in
   `lib/queries.ts`, with a focused test) as the guard against step 2 repeating
   RES-1. It reports exactly the 9 files on the pinned dataset.

**Repository note.** `test/efficiency/efficiency-queries.test.ts` was left
unparseable by commit `e11a0d3` (step 2h): `bun test` ran **0** tests in the file
and `tsc` fails on it, because two tests were spliced mid-body. Repaired here so
this branch verifies; the file now runs its 11 tests and the suite passes 52/52.

## Findings

| id | finding | quantified impact | kind |
| --- | --- | --- | --- |
| RES-1 | Harness source lost by a read-only open | 9 files → 0 rows; +2,263 turns / +2,804 calls on rebuild; slice unreachable | data |
| RES-2 | 11.7× cost for 1/7 the work, wrong model | $1.6765 vs $0.1437; $0.0838 vs $0.00099 per call (84×) | config |
| RES-3 | Half the context is re-touched files | 65/145 calls, 177,884/359,319 B; App.tsx in 10 read slices | prompt/tool |
| RES-4 | All search through `bash` | 119/130 shell calls; 15 `read`, 0 `grep`-tool, 0 `codemode` | tool definition |
| RES-5 | Latency grows with an uncompacted context | 6.4 → 19.2 s/turn; 72 % of wall time in the last 41 turns | config |
| RES-6 | No budget or stopping rule in either brief | research: none; debug: stop only on unreproducible | prompt |
| RES-7 | Debug surface never exercised; shared tools fail 8/28 | 0 debug/browser/http/evidence calls; `env_logs` 2/2 failed, `env_start` 4/11 | config/tool |
| RES-8 | The debug change parked 48 % of its wall clock | 1 h 48 m of 3 h 45 m; questions answered in 63 s | engine/task shape |

### RES-1 — the pinned dataset has no transcripts at all

- Evidence: `source_files` → 9 rows, every one `harness.*`, `records = 0`,
  `parsed = 0`, note `unreadable: unable to open database file`
  (`orchestrator/`, `wiki-workflows/`, `backend/`, `main-store/harness-stale-oct12`
  and five worktree stores). `SELECT COUNT(*) FROM turns WHERE source LIKE
  'harness%'` = 0, likewise `tool_calls`, `runs` and `events`.
- Quantified: rebuilding from the same snapshot with the `-shm` present gives
  668 workflows / 1,259 runs / 35,800 turns / 28,308 calls against the pinned
  668 / 1,238 / 33,537 / 25,504 — **+2,263 turns (+6.7 %) and +2,804 calls
  (+11.0 %)**, and those rows are the only place in the snapshot where stop
  reasons, thinking tokens, per-call result sizes and argument digests exist.
- Consequence for this step: the whole researcher slice is invisible from the
  pinned dataset; it is only readable from the raw snapshot. The checked-in
  `docs/efficiency/00-data-inventory.md` describes an earlier, readable build
  (666 workflows, 34,820 turns, 27,077 calls, 4,302 parsed harness records) and
  therefore overstates what the pinned dataset answers — its §9.4/§9.5 lists
  conversations and labels the pinned build cannot produce.
- Confidence: high; reproduced by rebuilding, and the cause is a one-line
  interaction between the snapshot's copy step (no `-wal`/`-shm`) and
  `lib/harness.ts`'s read-only open.

### RES-2 — the expensive research answer was bought with the wrong model

- Both sessions were asked the same way ("research, do not change code, report
  with file:line evidence"). The 20-call session cost $1.6765, the 145-call
  session $0.1437 — **11.7× for 13.8 % of the calls**; per call, 84×.
- Cost decomposition of the opus session (from the `pi.usage` document, which
  agrees with the summed per-turn counters to 4 decimals): cache-write $0.7017
  (41.9 %), output $0.6589 (39.3 %), cache-read $0.3157 (18.8 %). It wrote cache
  on 19 of 20 turns (24,436 / 5,248 / 10,337 … 6,770 tokens) and read 1.58 M;
  the flash session wrote **0** cache tokens and read 7.44 M — its provider
  prices prompt caching implicitly, the other bills 25× the read rate to write.
- The model changed inside the run: `pi.agent` carries a base revision with
  `opencode/space-bunny-free` (the launch preset, which the brief's session
  report names) and a later base revision with `github-copilot/claude-opus-5.5`.
  Turn 0 stopped with `error` and 0 tokens on the free model, so the run's work
  was done by opus. Confidence high on the numbers, medium on the cause (relaunch
  vs. per-turn override — the snapshot cannot distinguish), and I cannot say
  whether the expensive session's answer was better than the cheap one's: neither
  reached the wiki stage, so no review of either exists.
- Sanity: research is not an expensive role in general — $0.91/run against
  worker $1.99/run, planner $0.40/run. One run is the outlier.

### RES-3 and RES-4 — how a research session spends its turns

- Spend by tool, conversation 2: `bash` 130, `read` 15, nothing else; inside the
  bash calls, `grep` 52, `sed` 36, `cat` 13, `ls` 10, `wc` 4, `python3` 4,
  `find` 2, `git` 2, `head` 2, plus singular `mkdir`/`set`/`which`/`for`/`bun`.
  That is 119 text probes for a read-only investigation, 15 bounded reads, no
  `grep` tool, and no `codemode` — which the protocol recommends for exactly a
  "search → filter → summarise" pipeline and which the snapshot's other roles
  called 1,785 times.
- Repetition: 65 of 145 calls (44.8 %) targeted a file already touched by an
  earlier call in the same session; those calls returned 177,884 of 359,319 B
  (49.5 %). *Caveat*: the measure counts a new pattern over the same file as a
  repeat, so it is an upper bound. The tight lower bound is the reader: 15 `read`
  calls returned 99,531 B, of which **10 calls and 49,903 B (50.2 %) are
  `src/tui/otel/app/App.tsx`** in slices at offsets 180, 425, 640, 1436, 1470,
  1670, 1900, 2010, 2620, 2880 — three of them overlap by ~31 lines; the same
  file was grepped 4× and sed'ed 8× in bash. Five files account for 60 of the 145
  calls (41 %): `src/tui/index.tsx` 20 touches, `src/server/operations/observations.ts`
  12, `App.tsx` 18, `src/server/telemetry-db.ts` 6, `src/tui/dash/agent-session.ts` 4.
- By contrast the opus session's 20 calls are wide, not repetitive: 25 distinct
  source/spec files, 2 repeats (3.1 % of bytes), one `git ls-files`/`git status`
  orientation pair, then one file per behavioural claim. The cheap session
  behaves; the expensive one is the one that explores.
- Confidence: high on counts and bytes (transcript), medium on labelling it
  waste — several of the repeats are a new query against a file whose structure
  was already known, which a reader that returns ranges cannot avoid.

### RES-5 — latency follows the context, and nothing compacts it

- Conversation 2, turn wall time by bucket: turns 0–19 **6.4 s/turn** (127 s),
  20–39 7.8 s (156 s), 40–59 18.3 s (366 s), 60–80 **19.2 s** (385 s); total
  1,034 s = the session's 17.2 min. Context (cache-read, i.e. the prefix sent)
  grows 15.6 k → 177 k tokens; **0 compactions** in the session. The last 41
  turns (51 %) hold 72 % of the wall time.
- The durations attached to tool calls must not be read as execution time: they
  equal the following turn delta (turn 59 `set` 151,289 ms ↔ delta 151,310 ms;
  turn 79 `cat` 85,467 ↔ 85,488). So the 151 s "call" was the turn that ran an
  `rsync` of the repository and the 85 s one wrote the report file — but a 22 s
  `which`, a 21 s `mkdir` and a 28 s `ls` in the same session are turn latency,
  not process time, and they are what grows.
- Confidence: high for the arithmetic; medium for the cause. A second long
  session would separate "context size" from "provider load" — step 2h reports
  the same shape over 570 orchestrator turns.

### RES-6 — no budget, and the stopping rule is "the developer says so"

- `agent-definitions/instructions/research.md` (62 lines, ~4.5 KB) contains no
  turn, time, call or cost limit and no completion criterion for the
  investigation; the only stop is a `research-handoff` after the developer asks
  for a wiki entry, or the developer's `close-research`. `definitions/graphs/research.ts`
  bounds loops only for `blocked`/`failed` (3 attempts) and wiki review comments
  (6). The engine therefore cannot stop an open-ended session, and the two runs
  show what that means in practice: 20 calls when the agent judged it done, 145
  when it did not.
- `instructions/debug.md` (59 lines) is the opposite: an explicit stop (`blocked`
  when the behaviour cannot be reproduced), a required report skeleton, one
  request per run / two per workflow, and `definitions/graphs/debug.ts` loops
  `blocked`/`failed` 3× and comment rounds 5×. Neither brief mentions cost, and
  neither says how much exploration is enough.
- About 40 % of `research.md`'s text is the read-only/prompt-injection boundary —
  repeated in the `research-handoff` section and again in the assignment's
  protocol block. That is instruction budget spent on safety, not on shaping the
  work; I have no measurement of its effect on behaviour.

### RES-7 — the debug surface is unexercised, and its tools are shaky

- No debug run exists: 668 workflows and 1,259 runs contain no row with
  `debug` in the role, step or workflow id; `debug_requests` is an empty table in
  `main-store/herdr.db`, `store-backup-20261014.db` and `backend/herdr.db`; and
  across the whole snapshot there are **0** calls to `debug_request`,
  `debug_result`, `debug_wait`, `debug_cancel`, `browser_*`, `http_request` or
  `evidence_attach`. The 19 runs of `add-debug-subagent-requests` are the change
  that introduced the feature, not uses of it.
- The 28 calls to the tools the debug brief tells the agent to use, and their
  outcomes: `env_start` 11 (4 failed), `env_list` 6 (1), `env_logs` 2 (2),
  `db_query` 1 (1, then success 8.6 s later), `otel_query` 1 (0), `env_build` 2,
  `env_status` 2, `env_stop` 2, `env_test` 1 — **8/28 = 28.6 % failed**, every
  failure retried at least once. 27 of the 28 come from `env-setup` runs; one
  worker called `env_list` once.
- The failure modes, verbatim in kind (short tool messages, no data):
  - `env_list`: `this run has no agent environment capability (the workflow
    server did not provide one); the environment tools are unavailable` (162 B) —
    the first call of that run; the retry 40 minutes later returned 39,068 B.
  - `env_start`: `run target "app/grid-allocation-backend/action/run/docker/default"
    not found` (116 B), **four times**, 15.0 / 4.7 / 11.1 / 12.7 s apart, on the
    app the planned E2E debug run targets.
  - `env_logs`: `env_logs: no container runtime is available` (70 B), **both
    times**, while `env_start` was reporting the same app `running`.
  - `db_query`: `infra "postgres" declares no query connection, so it is not
    queryable [no-query-connection]` (130 B) on the first call, success after the
    declaration was edited.
  - `otel_query`: worked first try (3,562 B, 8.6 s) and returned a trace list.
  - Result size: `env_list` returns **31–43 KB per call** (5 successful calls ≈
    188 KB), the largest routine tool output in the slice.
- For the planned grid-allocation-backend E2E debug run (submit through the
  frontend, verify the email in Mailpit, verify OTel logging) the practical
  checklist is therefore: (1) confirm the env tools can see a container runtime
  before relying on `env_logs`; (2) declare a query connection for the app's
  Postgres infra, or `db_query` refuses with a config error rather than returning
  data; (3) expect the first `env_start` after a configuration change to fail
  with `run target … not found` and retry once, not four times; (4) tell the
  agent that one copy of an app runs at a time and to `env_stop` when done;
  (5) `otel_query` is the one tool with a clean record — the app does export.
- Confidence: high for the call counts and error strings; medium for
  generalising, since all 28 calls come from one machine in one week and "no
  container runtime" may be an environment condition rather than a product
  defect.

### RES-8 — the debug feature's own change, as a task shape

- `add-debug-subagent-requests`: 12:44:17 → 16:29:33 (3 h 45 m, 19 runs). Worker
  attempt 1 asked two developer questions (12:49:44, 12:52:26; answered
  12:53:33 and 12:53:47) and then handed off **blocked at 13:45:01**; the
  workflow stayed parked until `operator.repair` at 15:33:11; worker attempt 2
  (15:59:39 → 16:17:42) completed and the second verification round followed.
  Parked time 13:45→15:33 is **1 h 48 m (48 % of the workflow's wall clock)**.
- Its worktree is gone, so neither worker attempt has a transcript — the reason
  for the block is not recoverable, only that two questions were answered and the
  run still ended blocked 51 minutes later.
- The same waiting cost applies inside a research or debug session: across the
  snapshot `developer_question` blocked for **800 s on average (13.3 min)**, 4.59
  million ms at the worst (76.6 min). A research run that asks instead of
  deciding pays that; the two researcher sessions asked nothing.

## Justified — expensive but not waste

- **The 145-call session's big probes are a reproduction harness.** Its four
  longest turns (151 s, 85 s, 48 s, 29 s) are an `rsync` of the repository to a
  scratch directory, a scripted TUI driver, a frame capture and writing the
  report generator; turn 80's answer is the ranked 6-part deliverable the
  assignment asked for. $0.14 for a measured answer to a six-part question is the
  cheap end of this slice, not the expensive one.
- **The 10 `App.tsx` slices are bounded reads, not redundant ones.** A 2,900-line
  file read through `offset`/`limit` costs ~50 KB; the overlaps total ~31 lines.
- **No call is an exact repeat.** Matching on identical argument hashes finds
  zero duplicated calls in either session; every apparent repeat is a different
  pattern or range.
- **Interactive idling is the design.** The opus session worked 4 m 08 s, then
  waited for the developer ("continue" 38 s later, the follow-up question 8 m 41 s
  later). Idle turns cost nothing.
- **Research is cheap per run** ($0.91) compared with workers ($1.99), so the
  missing budget did not show up as systematic overspend.
- **`research-pi-durable`** costs $0.0808 over 149 turns: whatever that workflow
  is, it is not an example of research waste.

## Data limits

- **The pinned dataset cannot see this slice.** All harness rows are missing
  (RES-1); every per-turn, per-call and usage number here comes from the raw
  snapshot read through the repository's own reader. Findings that need only the
  pinned dataset are call-shape for `research-pi-durable` and the 19 runs of
  `add-debug-subagent-requests`.
- **n = 2.** Both sessions are on one machine, one week, one configuration, and
  the wiki host's durable store is absent, so research instances, steps, gates
  and handoffs are invisible and **no research output was reviewed or rejected in
  the snapshot** — "how often research output was redone" is unanswerable.
- **Conversation 463's turn timestamps are unusable**: many turns share a start
  time and every turn reports a 2 ms duration, so its cost cannot be attributed
  per turn (only its totals, which are exact).
- **Harness call durations are turn wall time**, not tool execution time
  (verified above), so no finding here depends on them for tool latency.
- **Nothing to measure for debug**: 0 runs, 0 requests, 0 browser/http/evidence
  calls. The debug findings are the brief, the graph and other roles' use of the
  shared tools.
- `introduce-research-workflow.jsonl` has 2,899 records (1,630 `runtime.tool`,
  996 `runtime.usage`, 48 `runtime.settled`, …) and the dataset normalises **0**
  of them — its `workflowId` is a UUID (`48fac845-…`) that matches no workflow
  row, so the "introduce the research workflow" era is not analysable. This is a
  second, unexplained undercount in the same snapshot as RES-1.
- The environment-tool failures are one machine's; `no container runtime` cannot
  be classified as product defect from this evidence.

## Recommendations, ranked by expected saving per unit of effort

1. **Fix the harness read in the dataset builder** (data, small). Open with
   `immutable=1` or copy the store and open it writable with `PRAGMA
   query_only = 1`; alternatively checkpoint or copy `-wal`/`-shm` in the
   snapshot step. Guard it with the `source-gaps` query added here (it reports
   exactly the 9 files today). Expected: restores 2,263 turns and 2,804 calls —
   including the only transcripts in the snapshot — for every step of this
   review; without it, the next deep dive re-derives what this one had to.
2. **Launch research sessions on the intended, cheaper model and make a
   mid-session model switch an explicit decision** (config, small; product
   correctness). Expected: a 20-call research answer costs $0.02–0.15 instead of
   $1.68 — about $1.5 per such session, 91.8 % of this slice's cost.
3. **Give `research.md` a stopping rule and a budget hint** (prompt, small):
   "when the deliverable is answerable, stop exploring"; "batch independent
   probes in one turn"; "prefer the reader over shell `sed`/`cat`". Measurable
   targets: the 49.5 % repeat-byte share and 1.63 calls/turn. Expected saving on
   the readable session is small (~$0.04); the value is bounding the unbounded
   case, which is where the 145-call session came from.
4. **State the research and debug profiles' tool surface in the brief**
   (prompt/tool definition, small). If `grep` and `codemode` are exposed, say so;
   if they are not, the protocol's "prefer the `read` and `grep` tools over
   `sed -n`/`cat`" is unactionable advice that costs 119 shell calls in one
   session. Same for the debug profile's browser/HTTP surface.
5. **Shrink `env_list`'s default result** (tool definition, small): 31–43 KB per
   call, and the briefs tell every debug and env-setup run to call it first.
   An app filter or a compact summary with an opt-in `detail` removes ~35 KB of
   context per run.
6. **Prepare the environment before the planned grid-allocation-backend E2E
   debug run** (config, medium): a visible container runtime for the env tools
   (`env_logs` has never succeeded on this app); a query connection declared on
   the `postgres` infra; and an expectation of one `run target … not found`
   retry after a configuration change rather than four identical attempts.
7. **Put env-setup's lessons in the debug assignment up front** (task shape,
   small): one copy per app, `env_stop` when done, `env_logs` needs the matching
   `service`, `no-query-connection` is a configuration gap rather than evidence,
   and an `otel_query` returning few traces means the app is not exporting.

## Open questions

- **Why was `claude-opus-5.5` used for the second research session, and is the
  preset→model mismatch a product bug or a developer override?** The transcript
  shows the model change but not who made it; the free model's turn-0 `error` is
  consistent with a relaunch, not a proof.
- **Was either research answer accepted?** Neither session reached the wiki stage
  in the snapshot and the wiki host's store is absent, so acceptance, rework and
  cost-per-accepted-report are unmeasurable.
- **Is a 49.5 % repeat-byte share typical for the role?** Two sessions cannot say;
  the six other worktree harnesses that RES-1 hides would give the same measure
  for other roles as a baseline.
- **Is the turn-latency growth a context effect or a provider effect?** A second
  long session — step 2h's orchestrator conversation shows the same shape — would
  settle it.
- **What blocked `add-debug-subagent-requests` at 13:45 after both questions were
  answered?** Only events survive; the questions' text is stored as a bounded
  digest, and the worktree is gone.
- **What happened to `introduce-research-workflow`'s 2,899 records?** Its records
  carry a workflow UUID that no workflow row matches; either the normaliser drops
  the "introduce" generation or that file belongs to a workflow the index never
  learned. Worth a look before the next dataset step.
