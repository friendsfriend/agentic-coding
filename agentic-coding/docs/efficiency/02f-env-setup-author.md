# Deep dive 2f — the env-setup author

Two `env-setup` author runs on the same app (`grid-allocation-backend`), one per
flow generation: the per-file-overlay flow of 2026-10-15 (run 1) and the
staged-config-root flow of 2026-10-16 (run 2). Both were read from the
pi-durable transcripts, the per-span telemetry and the durable store, all
outside the repository.

**Two fifths of run 2's wall clock went into one command that returned an
error.** Everything else in this slice is smaller than that.

## Summary

| # | finding | evidence | impact (measured) | confidence |
| --- | --- | --- | --- | --- |
| F1 | An unbounded recursive `grep` ran 20 min and was then aborted by the developer: 41 % of run 2's wall clock produced 50 bytes of output and a blocked/aborted handoff | run 2, turn 13 (11:47:47–12:08:07), `agent.handoff{blocked, aborted}`, `agent.resumed` + developer message at 12:08:10 | 1 202 s wall = 41 % of the 49.1 min run; 1 of 6 failed calls; 1 developer abort + resume | high |
| F2 | The author could not get one fact — which *default* target wins when a Docker and a shell build target coexist — so it grepped the 92 MB compiled binary (8 calls, 613 s) and read product source (16 reads, 60 KB); the same class of question cost run 1 495 s of product-source reading (50 calls) | run 2 turns 15–53 (853 s wall = 29 % of the run, 39 of 101 turns, 60 of 161 calls); run 1 turns 60–66, 104–106 | 1 290 s of tool time in run 2; 613 s of it on the binary alone | high |
| F3 | The write guard runs only at baseline/handoff/promotion and fingerprints the whole live configuration, including the platform's own state — run 1's guard failed twice on files the engine and TUI had written while the author worked | run 1: guard ok at 06:20:05 (2.4 s), failed 06:59:36 and 07:06:05; the agent traced the change to `tui.json` + 6 110 cache files under the config root (turn 94/95); 2 operator repairs, workflow ended `attention-required` | the last 20 turns / 23 calls / 5.8 min of run 1, after the failure; the run's already-finished work had to be repaired twice to reach promotion | medium-high |
| F4 | The staged root preserves the live configuration's symlinks, so writing a staged path that is a symlink writes **through** it into the live configuration: the author's compose write edited the developer's `~/devenv-config` checkout | run 2 turn 79 write → live diff of 173 lines; noticed and repaired at turns 95–100 (7 calls, 83 s); the staged path removed and re-written as a regular file at 12:34:49 | 1 write + 7 diagnosis/repair calls; a live file changed outside the drafts; the report artifact (12:32:44) predates the final draft (12:34:49) | high |
| F5 | The run record does not cover the session that ran under it, in this slice and dataset-wide | all 110 turns of run 1 belong to a run recorded `blocked` 41 min before the last turn; run 2's 102 turns to a run completed 27 min early; new `run-window-drift` query: 156 runs in 38 workflows | per-run wall time, cost and status in the dataset are wrong for both runs of this slice; the effort of 20 turns is invisible to any per-run rollup | high (data) |

The redesign between the two runs worked where it was aimed: the manual
container lifecycle the author had to drive by hand in run 1 (45 shell calls,
1 808 s, 66 % of that run's wall clock, because the env tools reported *no agent
environment capability*) fell to 356 s across 17 calls in run 2 (−80 %). It did
not remove any of the platform-comprehension cost above, which is the larger
half of both runs.

## Slice and method

**Slice.** Workflows `env-setup-grid-allocation-backend` (2026-10-15; runs
`11262606` attempt 1 `blocked` and `95abd536` attempt 2 `complete`) and
`env-setup-grid-allocation-backend-2` (2026-10-16; run `b6754a50`, still
`working` at the snapshot). Roles: `env-setup` only. 2 sessions, 2 720 s + 2 948 s
of wall clock, 383 tool calls, 0.360 provider cost units, 280 k output tokens,
34.5 M cache-read tokens — the whole env-setup family in this snapshot;
there is no other env-setup evidence here.

**Method and provenance.** The dataset's own rows for these two workflows are
thin (see Data limits): its `harness.backend` source failed to open
`backend/harness.sqlite` ("unreadable: unable to open database file"), so every
transcript-derived field — result sizes, per-call durations, error flags, stop
reasons — is missing, and `tool_calls.ok` is 1 for all 383 calls while the
transcript marks 14 of them as errors. I re-read that store read-only
(`?immutable=1`) and joined it to the 692 / 537 OTel spans in
`otel-tui/traces.sqlite`, which gave per-call start/end and the full argument
bodies, and to `backend/telemetry/*.jsonl` for the engine events. Every number
in this report is computed from those three sources plus `backend/herdr.db`;
the dataset was used only for cross-checking, and the queries named under
*Recommendations* are its own.

**Per-run numbers used throughout** (wall = first turn → last result):

| | run 1 (per-file overlay) | run 2 (staged root) |
| --- | --- | --- |
| window | 06:20:06–07:05:32 (45.3 min) | 11:46:01–12:35:09 (49.1 min) |
| turns / calls | 110 / 222 | 101 / 161 |
| tool busy (per turn) / model latency | 1 367 s (51 %) / 1 214 s (45 %) | 1 794 s (61 %) / 1 147 s (39 %) |
| tools | bash 199, write 9, edit 5, env_start 4, env_list 2, read 1 | bash 122, read 16, write 6, env_start 3, env_stop 2, env_logs 2, env_build 2, edit 2, codemode 2, otel_query/env_test/env_list/db_query 1 |
| failed results | 8 (2 aborted by the developer) | 6 (1 aborted by the developer) |
| cost / output tokens / cache reads | 0.2012 / 157 k / 19.9 M | 0.1590 / 123 k / 14.6 M |
| cache hit rate | 98.4 % | 98.2 % |
| calls per turn | 2.02 (37 single-call turns) | 1.59 (46 single-call turns) |
| bash calls that a dedicated tool covers | 123 of 199 (61.8 %) | 79 of 122 (64.8 %) |

## Findings

### F1 — a 20-minute command, aborted, and a developer intervention

Run 2, turn 13: at 11:47:47 the author issued one recursive grep for a symbol
name across three roots — the live configuration directory, the product
repository and `/Applications` — with no `timeout` argument. The tool result is
`Tool bash was aborted` after **1 202 s (20.0 min)**, at 12:08:07, the exact
instant the engine recorded `agent.handoff{outcome: blocked, aborted: true}` and
the workflow went `attention-required`; three seconds later `agent.resumed`
carried park `abort-marker` and the developer's message *"No global finds"*.
The run then continued for another 27 min.

Impact: 1 202 s = 41 % of the run's wall clock, 67 % of its tool time, for a
50-byte error result. It also cost one developer intervention (abort, resume,
message) and one blocked handoff — the only two failure events in the run. Run
2's most expensive *useful* command was 41 s (the staged build).

Run 1 shows the same shape at a smaller scale and by the same mistake: turn 5
issued a repository-wide `find` from `/` (no timeout), which the developer
aborted after 227 s with the same message. That one ended the first attempt:
`agent.handoff{blocked}` at 06:24:26, and the next 35 min of work ran under the
dead run id (F5).

Both runs were lectured *"No global finds"* by the developer, and the protocol
the author received says "Use scoped repository tools only. No filesystem-global
searches" — the instruction exists and was not enough. The tool itself has a
`timeout` parameter the agent did not use, and no default.

*Confidence:* high. Durations come from paired OTel spans (`runtime.tool_start`
→ `runtime.tool`), the abort from the transcript error text and the durable
handoff event, at the same second.

*Recommendation (config, tool definition):* give `bash` a default wall-clock
bound (e.g. 120 s) that the result states when it fires, and/or have the harness
surface a "this call has run N s" note to the model at ~60 s. Keep `timeout` as
the override. *Kind:* tool definition + engine.

*Verification:* per run, count calls with span duration > 60 s and the number of
aborted calls, before and after; `analyze.ts turn-gaps` and the same span join
used here are enough.

### F2 — "which default target wins?" cost a third of the run, and the answer was in the tool output the whole time

The assignment requires the report to state **the default target per action**.
For `grid-allocation-backend` two build targets of profile `""` are live (a
Dockerfile and a shell script), and the supersede rule decides whether the
author's draft displaces one of them. `env_list` at turn 0 already said both
targets are `defaultAmbiguous: true` — and said nothing about what resolves the
ambiguity. The word appears nowhere in the 30 KB assignment either.

So the author tried to read the rule out of the product: turns 21–23, 39, 41,
43, 48 and 51 grepped the 92 MB compiled `dist/agentic-coding` binary with
`grep -a -o` patterns (8 calls, 613 s, the largest 137 s); turns 28–53 read
`discovery.ts`, `setup-validate.ts`, `agent-routes.ts` and `instances.ts` (16
`read` calls, 59.7 KB, nine of them the same 1 322-line file); turn 46 ran `wc
-l` and turn 45 printed source through `sed`. The whole episode is turns 15–53:
12:08:23 → 12:22:36, **853 s = 29 % of the run's wall clock, 39 of 101 turns,
60 of 161 calls, 1 290 s of tool time**. It ended only when the author stopped
asking and observed behaviour instead: `env_build` on the staged shell target at
12:24:12 returned the resolved `targetId`, and from then on no more product
source was read for this question.

The instruction — one sentence, near the end of the 30 KB message — does state
the rule ("a drafted build or test target supersedes the live one of the same
app, action and profile"), but the tool output that poses the question uses a
bare flag with no sentence attached. Run 1, with a *shorter* and
differently-worded brief, spent 495 s (50 calls, 30 turns) on the same class of
question — reading the platform's TypeScript to learn how drafts, target ids and
the compose path resolve. The information gap survived the redesign; only its
symptom changed (source reading → binary grepping).

Impact: 853 s of 2 948 s in run 2 (29 %); a further ~300 s of the same question
in run 1. Tool time spent on the product's own source in run 2: 2 528 s across
73 calls = **66 % of all tool time in that run**.

*Confidence:* high for the measurement, medium for the attribution of each call
to "only this question" (I read the arguments and the following turns to
classify them; the infra/OTel part of the source reading, turns 58–78, is a
different question — how `requires`/infra and the OTel wiring resolve — and is
*not* counted here).

*Recommendation (tool definition, prompt):* `env_list` should answer the
question it raises: an explicit per-app `defaults` block naming the effective
default target id per action, the reason (`default`, `only-target`, or
`ambiguous`), and — when a draft exists — which live ids it supersedes; plus a
one-line hint on an ambiguous group ("two build targets of profile '' are live
with no draft to settle the choice"). The engine already computes all of it
(`defaultTargetOf`, `supersededIds` in `setup-validate.ts`); the tool exposes the
raw flag instead. Add one sentence to the "Run what you authored" section
pointing at that field name, so the brief and the tool use the same word.

*Verification:* count, per env-setup run, the calls whose arguments reference the
product repository or `dist/agentic-coding` (73 in run 2, 50 in run 1) and the
wall time of the window between the first `env_list` and the first `env_build`.
A drop to single digits with no loss of report accuracy is the target.

### F3 — the write guard runs last, and it fingerprints the platform's own state

The `environment.setup-guard` effect is armed as a baseline before the author's
first turn and re-checked at the agent's handoff and again at promotion; it
compares a fingerprint of the live configuration root and of the app checkout
(`git status --porcelain` + HEAD). In run 1 all three phases behaved as
designed, and the outcome was still wrong: the baseline passed at 06:20:05
(2.35 s), the handoff check failed at 06:59:36 with *"the live configuration
changed outside the drafts directory"*, the developer repaired the step, and
the promotion check failed again at 07:06:05, adding *"the repository checkout
changed"*. The workflow ended `attention-required` (teardown 07:09:30).

The author's own investigation (turns 94–95, 07:00:17–07:00:51) shows what had
changed in the configuration root outside `.drafts`: `tui.json` (written
08:59 local, i.e. 06:59 Z — while the run was arming its handoff) and the
environment server's target cache under `.agentic-coding-workflow/targets/`
(6 110 files, several written 08:52 local). Those are the *platform's own*
files, written by the TUI and by the author's own `env_list`/discovery calls.
The checker's verdict therefore depended on activity that has nothing to do with
the author's drafts, and it was reached only at the two mutations that matter
most (handoff, promotion) rather than while the offending write happened.

Cost: the guard's own runtime is trivial (2.4 s + 0.9 s + 1.3 s); the cost is
structural — 2 operator repairs, 1 forced step transition, 20 turns / 23 calls /
5.8 min of agent work after the failure (turns 90–109), and a workflow that
cannot leave `setup.author` on its own. An early (or continuous) check would have
flagged the same condition minutes after the first write, and a fingerprint that
excluded the platform's own state would not have flagged it at all.

*Confidence:* medium-high. The failure texts, timings and the agent's file
provenance are exact; which of the two writers (TUI vs. the author's own
discovery calls) tripped the config-side fingerprint cannot be separated from
the evidence, and the checkout-side change at 07:06:05 is *not* explained by
anything I can see — the author's own `git status --porcelain --untracked-files=all`
at 06:59:54 was empty.

*Recommendation (engine):* (a) exclude the platform's own runtime state
(`.agentic-coding-workflow/**`, `tui.json`, backups) from the configuration
fingerprint, or move that state out of the configuration root; (b) re-check on
each author turn (or on each write) so the author learns about the violation
while it still owns the context, instead of parking the step afterwards.

*Verification:* guard-failure events per env-setup workflow and the number of
turns/calls that follow the first failure; plus a diff of the fingerprint's file
set against the files a run actually wrote.

### F4 — the staged root preserved a symlink into the live configuration, and the author wrote through it

The staged-root flow copies the live configuration, symlinks included, and the
brief says so ("The live configuration's own files are already in the root
(including its symlinks), so an untouched copy is not a draft"). One of those
symlinks is
`root/apps/compose/grid-allocation-backend-compose.yml → ~/devenv-config/devenv/apps/compose/…`
(created by the stage effect at 11:45). At turn 79 (12:28:22) the author wrote
its compose draft to that staged path: `Successfully wrote to …/.drafts/…/root/apps/compose/…`,
which is the live file. Turn 97 measured the damage (`git diff --stat` of the
live repository: 173 changed lines) and turns 95–100 (12:33:46–12:35:04, 7 calls,
83 s) diagnosed it: the staged entry was a symlink, the live file had the
author's content, and the fix was to delete the staged symlink and write a real
file (12:34:49) — leaving the live file modified. The brief reports that the
developer restored it by hand; the snapshot cannot show the restore.

Two second-order costs: the run's own evidence artifact was written at 12:32:44,
*before* the final compose write at 12:34:49, so the report describes a draft
that changed afterwards; and this is very likely the write that would have
failed the guard when the run finally handed off (the snapshot ends before that
handoff, see Data limits).

This is the *second* generation of the same accident: in the overlay flow the
same symlink exists in the live configuration (`apps/compose/…` → `~/devenv-config`),
and run 1 only avoided it because a draft in the overlay flow is a *new* file at
the draft path. The staged copy reintroduced the hazard by preserving the link.

*Confidence:* high. The write result, the `ls -la` of the staged path
(`lrwxr-xr-x`), the live `git diff --stat` and the repair sequence are all in the
transcript.

*Recommendation (engine/config):* materialize symlinks in the staged root as
regular files (so "write the file you mean to promote" is true by construction),
or, if the link must be preserved, list the staged symlink targets in the
assignment and refuse a write whose resolved path leaves the staged root.
*Kind:* stage effect / guard. *Verification:* count staged paths that are
symlinks, and live-configuration `git diff` during an env-setup run.

### F5 — the run record does not cover the session that ran under it

Both runs of this slice are mis-attributed in the dataset, and the mechanism is
systemic:

- run 1 `11262606` is recorded `blocked`, started 06:20:06, **completed
  06:24:26** — while all 110 turns and the whole 0.2012 cost hang off it, the
  last turn ending 07:05:32 (a 41-minute tail). The second run `95abd536` is
  recorded `complete` with a 20-second duration and zero turns.
- run 2 `b6754a50` is recorded `working` with `completed_at` 12:08:07 (the
  aborted handoff), while its 102 turns run to 12:35:09 (a 27-minute tail).

So "4 minutes, blocked" is the label on 45 minutes of work, and every per-run
rollup (status, duration, cost per minute, "stalled run") for this slice is
wrong. I added the query `run-window-drift` to `scripts/efficiency/analyze.ts`
to make this visible dataset-wide: **156 runs in 38 workflows** have turns that
continue past their recorded completion; median tail 1 025 s, p90 5 748 s, max
63 380 s (a single `improve-test-performance` worker run carries 886 turns
across a 17.6 h tail).

*Confidence:* high for the data, medium for the interpretation (a resumed
session legitimately continues after its run is closed; what is wrong is that
the *turns and cost* are attributed to the closed run and that the delta is
invisible).

*Recommendation (engine):* either close a run when its session is closed, or
record the session window separately so a per-run rollup can say "these 110
turns ran after this run ended". *Verification:* the `run-window-drift` query.

### F6 — smaller, measured items

| item | evidence | measured | confidence | recommendation |
| --- | --- | --- | --- | --- |
| `env_start` cannot resolve an id `env_list` advertises | run 1: the `env_list` result at turn 98 lists `app/grid-allocation-backend/action/run/docker/default`; the four `env_start` calls at turns 99–103 (one of them passing exactly that string) all fail with *that same id* "not found" | 4 failed calls, 43.5 s, plus 3 diagnosis calls and one aborted 68 s codemode (turns 104–106) ≈ 2.4 min | high | the two tools disagree about the id vocabulary (run 1's list carries an `action/` segment, run 2's staged list does not); `env_start` should either accept what `env_list` prints or say what it does accept — echoing the id it could not find tells the author nothing |
| `env_logs` unavailable in this run | run 2 turns 59 and 91: `no container runtime is available` (the author then used `docker logs` through bash, 2 calls, 62 s) | 2 failed calls, 16.7 s | high | the tool description should say when it is unavailable to an author run, or the call should fall back to the container-log path the author used |
| `db_query` reachability | run 2 turn 84: `infra "postgres" declares no query connection` | 1 failed call, 8.6 s | high | `env_list`'s infrastructure entries carry only `{ident,type}`; add whether a query connection exists and its endpoints/ports |
| the author's own probe files | run 2 turn 18 writes two probe Dockerfiles into `root/apps/build/`; removed at turn 56 | 3 calls; they sat in the promotable staged root for 14.5 min | medium | a "staged root diff" line in the handoff/validation output would surface leftovers; today only the validation gate's drafts list does |
| compose churn | run 1 writes/edits the compose file 7 times (turns 63,67,72,76,78,79,81); run 2 4 times (79, 85, 87, 99) | 11 calls, each 6–51 s of span time | high | expected for a first authoring pass; matters only because each rewrite is a full file body (~9 KB written per call) |
| context growth | run 2: 20.6 k input on turn 0 (cacheWrite 0), cache reads 55 k at turn 10 → 266 k at turn 100, 98.2 % hit rate, no compaction in either run | 14.6 M cache reads = the cheap part of a 0.159-unit run | high | no action: compaction would have added a rewrite for ≤0.03 units of savings |
| instruction and tool-definition weight | delivered message 26 456 (run 1) / 30 248 chars (run 2); 41 tool definitions, 34.8 / 35.4 KB; `codemode` section 13.9 / 14.2 KB; first turn 19 572 / 20 623 input tokens uncached | 0.0030 / 0.0032 units (1.5 % / 2.0 % of the run) per run, then cached | high | not a cost problem; the *content* gap (F2) is the problem |

## Looked wasteful but justified

- **Run 1 running docker/maven by hand** (45 shell calls, 1 808 s, 37 turns,
  66 % of that run's wall): the author's first `env_list` returned *"this run has
  no agent environment capability … the environment tools are unavailable"*, so
  there was no managed path; the tooling only appeared after 06:59 when the
  developer restarted the server. Given that, driving `mvn`/`docker compose`
  manually is the correct behaviour — and run 2's tools removed 80 % of it.
- **Reading the product's source** to answer F2: the *intent* was right (the
  author was told to state the default target and the tool output was ambiguous)
  and reading `setup-validate.ts` did answer it. Only the method — grepping a
  92 MB compiled binary with eight `grep -a -o` calls — was wasteful; the 16
  `read` calls (60 KB) are a reasonable price for it.
- **The nine reads of the same 1 322-line file** (`setup-validate.ts`): different
  ranges, and the file is where the rule lives. ~30 KB of context, no measurable
  wall-time cost.
- **Three start/stop cycles and the build/test round in run 2** (`env_build`
  54 s, `env_test` 49 s, three `env_start` + two `env_stop` = 57 s of waits):
  the author changed the compose twice and re-validated readiness each time.
  That is the workflow working as intended, at ~5 % of the run.
- **`env_build` on the Docker target returning `"status": "failed"` with
  `exitCode: 0`** (run 2, turn 14, 13 s): not a retry loop and not ignored — the
  author used it, replaced the target with a host-maven shell build and said so
  in the draft's own comment. Run 1 paid far more for the same fact (5
  `docker build` calls, 194 s, plus maven/DNS probes) because it had no
  `env_build`.
- **Thinking volume** (454 k / 385 k characters of reasoning) and 37 / 46
  single-call turns: this is one long authoring task with a written report;
  output tokens per turn are modest (mean 1 429 / 1 221). No evidence of a
  non-converging loop: exactly 2 / 3 redundant calls by argument identity.
- **Run 1's last three turns** ("where did you define those definitions?"):
  developer Q&A in the session, not waste.

## Data limits

1. **The dataset has no transcript for either run.** `harness.backend`
   (`backend/harness.sqlite`, 3.1 MB, 2 conversations, 211 assistant entries,
   383 tool results) failed to open during the build: *"0 conversation(s);
   unreadable: unable to open database file"*. The file opens read-only with
   `?immutable=1`, so this is a reader bug, not a corrupt file. Consequences in
   the dataset: no `result_bytes`, no `duration_ms`, no error flags, no stop
   reasons, no thinking tokens for this slice; both workflows are classified
   "calls with args" although they are among the few with a full transcript. The
   `skipped` query does **not** surface it (the row has 0 records *and* 0
   skipped), so the loss is invisible to the tooling.
2. **`ok` is not the outcome.** All 383 calls in `tool_calls` carry `ok = 1`
   (`error_class` NULL), while the transcript marks 8 (run 1) and 6 (run 2)
   results as errors. The telemetry outcome is the envelope's, not the command's.
3. **The brief's "~14 transcript turns" for run 2 undercounts**: conversation 685
   holds 101 assistant entries / 161 tool results (run 1's conversation 2 holds
   110 / 222). The telemetry has 102 turn starts for run 2, one more than the
   transcript.
4. **Wall time needs the span store**: the telemetry for this slice carries no
   durations (only `durationMs` on effect events), so call durations, aborts and
   idle gaps come from the OTel spans. Turn-level "model latency" is the span's
   first tool start minus the assistant entry's timestamp; if the entry is
   committed at request start (which the 7 s of inter-turn gap in run 2 implies),
   this is the model's own generation time — but that assumption is unverified.
5. **Run 2 is partial.** The snapshot (12:35:22) ends while the run is still
   `working`: the final handoff, the guard check and the validation are not in
   the evidence. F4's connection to a guard failure at handoff is an inference
   from the live-configuration write, not an observed event. W1's guard episodes
   are complete and are what F3 rests on.
6. **The guard's fingerprint set is inferred** from the current checkout's
   `fingerprintCheckout`/`setupGuardViolations`. The 2026-10-15 build may differ.
7. **Cache accounting is absent**: every turn reports `cacheWrite = 0`, so the
   cost of a cache that expired across the 20-minute gap (F1) cannot be measured.
8. **Everything outside the snapshot is unverifiable for me**: whether the
   developer restored `~/devenv-config`, what the 6 110 target-cache files
   contained, and what the TUI was doing at 08:59 local.
9. **`defaultAmbiguous` semantics** are read from the product source
   (`defaultTargetOf`), not from the run's own build; the *field* is exact (it is
   in the run's `env_list` output), the code path is today's.

## Recommendations, ranked by expected saving per effort

1. **Bound `bash` by default (120 s, stated in the result) and nudge at ~60 s.**
   Removes the single largest item in the slice (F1: 1 202 s + 227 s = 23.8 min
   and both developer aborts) for a small, local tool-definition/engine change.
   *Verify:* calls > 60 s and aborted calls per run.
2. **Make `env_list` answer the default-target question** (effective default per
   action + why + what a draft supersedes + a hint on ambiguity), using the
   engine's existing `defaultTargetOf`/`supersededIds`. Targets the 853 s (29 %)
   of F2 and the same question's 495 s in run 1. *Verify:* product-source and
   dist-binary calls per env-setup run; window from first `env_list` to first
   `env_build`.
3. **Check the write guard early and continuously, and stop fingerprinting the
   platform's own state** (F3). Costs the author nothing when the drafts are the
   only thing written; saves a parked step and a 5.8-minute repair round when
   they are not. *Verify:* guard-failure events and the turns after the first
   failure.
4. **Materialize symlinks in the staged root, or declare and refuse them** (F4).
   One write plus 83 s of repair in run 2, a live checkout modified, and a
   report that describes a draft that then changed. *Verify:* symlinks under the
   staged root; live-config `git diff` during a run.
5. **Fix the `env_start`/`env_list` id vocabulary and give `env_logs`/`db_query`
   an availability line** (F6 rows 1–3): ~2.5 min plus four failed calls in run 1
   and three failed calls in run 2, all of them cheap individually and all of
   them pure vocabulary.
6. **Fix the dataset's harness reader (`?immutable=1`) and make `skipped` show
   unreadable sources** (Data limits 1–2). No effect on the agent, direct effect
   on every later efficiency step: this slice's entire call-level detail was one
   bug away from being lost.
7. **Attribute a session to its run window** (F5): 156 runs in 38 workflows
   currently carry work their run record denies. *Verify:* `run-window-drift`.
8. **At handoff, diff the staged root against the artifact's draft digest**
   (F6 rows 4 and 5): catches probe files (14.5 min in the promotable root) and
   a report that predates its own final draft.

## Open questions

- Which writer flipped the configuration fingerprint at 06:59:36 in run 1, and
  what changed the *checkout* fingerprint at 07:06:05 while
  `git status --porcelain --untracked-files=all` was empty in the same session?
  A guard that logs the file set it compared would settle both.
- Would a 120 s bash bound break the legitimate long commands in this family
  (a first `docker build` or `mvn test` can exceed it)? The evidence here shows
  both runs' long commands were either aborted or backgrounded by the author
  itself, but a structured `env_build`/`env_test` path exists exactly for those.
- Does the guard's *checkout* fingerprint intend to cover build output
  (`target/`, `node_modules`)? If a background build writes there, every
  env-setup run would fail its promotion check for a reason the author cannot
  control.
- How often does a resumed session continue after its run closes *because the
  engine parks the step* (run 1's repair) versus because the session is simply
  still alive (run 2's abort/resume)? The two cases need different fixes.
- Why could `env_start` not resolve `app/grid-allocation-backend/action/run/docker/default`
  in run 1 when its own `env_list` had just printed that id, while run 2 (staged
  flow, ids without the `action/` segment) started the drafted target normally?
  The id vocabulary in `env_list` changed shape between the two flows, and only
  one of them was resolvable.
