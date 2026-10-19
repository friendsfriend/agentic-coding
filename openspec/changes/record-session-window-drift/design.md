## Context

A run has two windows and only one of them is recorded. The **run window** is the
engine's: `workflow_runs.started_at` to `completed_at`, closed by the run's
`agent.handoff` (or by expiry). The **session window** is the durable host's: one
pi-durable conversation per canonical agent name — `(workflow, step, role)`,
stable across rounds, attempts, repairs and resumes — which outlives any single
run it serves. Nothing in the record says that a session continued, so every
turn a session emits after the run it was bound to has closed lands after that
run's `completed_at`.

Measured on the pinned snapshot, restored to the repository's current denominator
(441.9321 preferred cost units / 1,259 runs / 34,711 turns):

| figure | value |
| --- | --- |
| runs carrying turns after their own recorded completion | **156 of 1,259** (12.4 %), in **38** of 668 workflows |
| turns those runs carry, and turns in their tails | **14,163** of the 34,711 the snapshot records; **11,960** of those turns start *after* the run's own recorded completion (`SUM(tail_turns)` of the drifting rows, 34.4 %) — turn counts as the snapshot records them, before the cost repair, and not a ratio against the repaired cost denominator below |
| preferred cost those runs carry | **114.50 of the repaired 441.9321** units (25.9 %) |
| tail after completion, over the 156 rows | median **1,032 s** (median-high), p90 **5,748 s** (nearest rank), max **63,380 s** |
| runs that record no turns at all | **315 of 1,259** (25.0 %) |
| sources of the drifting rows | `traces.otel-tui` 78, `telemetry.main-store` 76, `telemetry.backend` 1, `herdr.backend` 1 |
| drifting rows whose completion precedes their own start | 62, all of them `traces.otel-tui` |

**Cause A — the runtime stream freezes its identity on the run that created it
(dominant).** `DurableHost.ensureRun` (`src/agent-host/host.ts`) resolves the
conversation, builds the run's `TelemetryIdentity` from the run environment, sets
`this.telemetryIdentities` for it, and attaches the runtime telemetry stream only
when the conversation has none: `if (!this.telemetry.has(conversation.id))`. The
stream is a closure over that first identity, and `attachTelemetry` passes it to
every envelope it emits (`emit(identity, …)` in `src/agent-host/telemetry.ts`).
The identity therefore names the run that created the conversation, not the run
working, and the conversation is reused by every later run of the same step and
role. The evidence is readable in the raw telemetry: in
`add-definition-family-traits` (2026-10-06) the `migration-verifier` conversation
settles at 14:03:27 and again at 14:20:03, both stamped `d4c2724b` — the attempt-1
run, which the engine closed at 14:03:04 — while the attempt-2 run `9739791f`
(14:14:33 → 14:19:53) records **zero turns**. `introduce-research-workflow`
(2026-08-31) is the same shape at scale: the first `core.triage` run `6689f896`
closes at 13:30:06 and its conversation keeps emitting `runtime.started` /
`runtime.settled` at 13:32:33, 13:51:28, 14:18:16, 14:28:37, 14:50:11, 15:02:15 and
15:11:33, while the five later `core.triage` runs of that workflow record zero
turns each. The frozen identity also carries the *hooks* of the first run: the
cost ceiling (`onMeasuredContext` → `observeContext(input.runId, …)`) and the
dead-surface monitor (`onToolOutcome` → `onToolOutcome(input.runId, …)`) are
bound to the creating run, so a later run's ceiling and monitor decisions are
recorded against the earlier run.

**Cause B — the traces reader dates a run by the first span it finds
(`traces.otel-tui` only).** `scripts/efficiency/lib/traces.ts` takes a span's
`start_nanos` as the event's `at`, and an `agent.handoff` span (scope `engine`,
service `herdr-workflow`) starts when the run is launched and ends at the
handoff: run `14639bc1` of `improve-test-performance` spans
12:54:20.318 → 14:14:14.608 and gets `completed_at` ≈ its own launch. 62 of the
78 trace-sourced drifting rows complete at or before their start, and those runs
then carry a tail of up to 63,380 s that is no run's work at all.

Both causes produce the same symptom, and the fix for one cannot fix the other:
A is a record that does not state the session window (and an attribution that
follows from it), B is a reader convention.

Constraints that shape the design:

- The dataset's numbers are reproducible: a reader change that rewrites a
  historical source's semantics is a change to every figure computed from it.
- `STORE_SCHEMA_VERSION` stays 6; no migration, no compat shim, no change to when
  a run or workflow blocks, completes, resumes or is closed.
- The harness reader repair (item 0) set the precedent: a source that parses
  nothing must fail the build (`scripts/efficiency/lib/empty-sources.ts`), and an
  alarm is a build failure, not a note.

## Goals / Non-Goals

**Goals:**

- Record the session window: which run a reused conversation was bound to, when
  the binding moved to another run, and why.
- Attribute a turn to the run that was working when the turn started, so a later
  run's turns are that run's turns (and the run that created the conversation
  keeps only its own).
- Make `run-window-drift` say, per drifting run, whether the tail is a recorded
  continuation, a clock artifact, or neither, and how many turns it holds.
- Make the dataset build refuse to write a dataset that contains an unexplained
  tail, without failing on the pinned pre-record snapshot or on a source this
  record cannot speak about.

**Non-Goals:**

- Closing a run when its session stops, or a session when its run stops. A run
  ends when the engine says so (handoff, expiry); a session is the host's and
  keeps serving later runs. Changing either would change when a workflow blocks,
  completes or resumes, and would break resume: a resumed run is the *same* run
  and must keep its window.
- Changing the run window's definition, the store schema, the CSV or number
  formats, or `engine.ts`.
- Rewriting the traces reader's `at` convention (Cause B is classified, not
  fixed; see Decisions).
- A per-turn `session_id` on the store, or anything the store would have to
  migrate.

## Decisions

### D1 — Record the session window; do not close the run on session end

Two options were on the table:

1. **Close the run when its session stops.** The run's `completed_at` becomes the
   last turn rather than the handoff. Rejected: it changes when a run — and so a
   workflow — is complete, which is exactly the behaviour this effort froze; it
   retroactively relabels runs whose session is *resumed* later; and the engine
   has no session-end signal that is not an engine-side decision anyway.
2. **Record the session window next to the run window.** Additive, purely
   telemetry: the run window keeps its meaning, and a reader learns that a run's
   session continued under a named later run. Chosen.

The record is two runtime envelopes on the conversation's *binding*:

- `runtime.session_window.opened` — the identity of the run now bound to the
  conversation; payload `herdr.session.reason` ∈ `created` (the conversation was
  made for this run), `rebound` (an existing conversation previously bound to a
  different run), `adopted` (an existing conversation whose previous run the host
  cannot name — a host restart), `resumed` (an existing conversation bound to the
  same run again, e.g. after an abort). On `rebound`, payload
  `herdr.session.previous_run_id`.
- `runtime.session_window.closed` — the identity of the run being left, payload
  `herdr.session.rebound_to` = the run now bound.

Both carry the conversation id as `herdr.session.conversation_id` — never as the
envelope's `sessionId`, which means *run* id everywhere else
(`src/server/telemetry-parser.ts` maps it to `herdr.session.id`), so one session
is one key across its runs without two identifier spaces under one attribute.
Both are emitted by the host, not the engine, and neither writes workflow state:
no snapshot field, no store column, no effect, no `STORE_SCHEMA_VERSION` change.
The envelopes land in the dataset's `events` table with `run_id`, `at` and their
payload, which is what the query reads; those four new `events` columns
(`session_reason`, `session_rebound_to`, `session_previous_run_id`,
`session_conversation_id`) are why `DATASET_SCHEMA_VERSION` moves 3 → 4,
append-only within the version. A *file* an earlier build wrote has no such
column at all, so every reader refuses it by name
(`assertDatasetSchemaVersion`) instead of dying on `no such column`: there is no
conversion, only a rebuild.

### D2 — The stream resolves its identity per envelope; the binding moves with the run

`attachTelemetry` takes `identity: TelemetryIdentity | (() => TelemetryIdentity)`
and resolves it at each emission, so one stream can serve several runs over its
life. The host keeps one binding per conversation — the last run bound to it —
and updates it in `ensureRun` *before* the run's first prompt:

- the previous binding's run id (when it differs from the new one) is what
  `runtime.session_window.closed` names;
- the new identity, plus the record's payload, is what `runtime.session_window.opened`
  carries;
- the hooks that name a run resolve the run that *produced* the observation
  rather than closing over `input.runId`: `onMeasuredContext` → `observeContext`
  is charged to the run whose message carried the measurement (the identity the
  stream resolved for that batch), and `onToolOutcome` → the dead-surface monitor
  is charged to the run that started the call (`callOwners` by `toolCallId`), with
  an observation for a run the host no longer tracks ignored. A decision the
  monitor takes is acted on with the failing run's own context, and refused when
  a later run now holds the conversation (SEC-003). The hook signature does not
  change: the host closes over the identity the event was delivered under.

The binding map is keyed by conversation and survives a run's retirement
(`stopRun` keeps deleting the per-run maps it deletes today — `runs`, `contexts`,
`timings`, `ceilings`, `telemetryIdentities` — but not the session window), so a
conversation reused after its run was retired still names the run it left. A host
restart clears the map with the rest of the host's memory; a conversation then
reused is `adopted` and no `closed` record is written, because the host cannot
name a run it no longer remembers. `watchEvents` streams only what is published
after the attachment, so the turns a conversation produced while no stream was
attached are attributed to nobody — they are absent, not misdated. The hole that
leaves is the one no host can close alone, and the analysis does not pretend
otherwise: a session that went on under a later run *across a host lifetime*
leaves the leaving run with only the binding it got before its own completion
(`created`/`rebound`), and a binding states no continuation. Only a `closed` row,
an `opened` row at or after the run's own completion, or the `resumed` reason
explains a tail; anything else is `unexplained`, which is a defect and not a
restart false positive, because the run whose record is missing is the run the
alarm is about.

Emission is best-effort and observational, like the rest of the stream: a failure
to attach, or to emit, never fails a run, and no emission happens before the
binding is updated. A conversation with no run id in its environment (an
orchestrator session) records nothing: the analysis is about runs.

### D3 — `run-window-drift` classifies the tail instead of only measuring it

The query keeps its columns (`run_id`, `workflow_id`, `role`, `status`,
`run_started_at`, `run_completed_at`, `turns`, `first_turn_at`, `last_turn_at`,
`tail_seconds`, threshold > 1 minute) and adds:

- `tail_turns` — the turns that started after the run's completion;
- `session_opened_after_completion` — `1` iff one of this run's own `opened`
  rows falls at or after its completion: the recording states that the session
  was bound to this run again after the run closed;
- `session_reason` and `session_rebound_to` — the run's *latest* binding reason and
  the run its latest `closed` names (correlated by `at DESC`, not `MAX` of the
  text: a conversation bound twice to one run, `created` then `adopted` after a
  host restart, must report the later move);
- `drift_kind`, decided in the order `clock-artifact` → `attributed` → `resumed`
  → `unexplained`:
  - `clock-artifact` — `run_completed_at <= run_started_at`, i.e. the run's own
    window cannot be read (Cause B). Nothing can be concluded from a tail with no
    beginning, so this class wins outright;
  - `attributed` — a `runtime.session_window.closed` row names this run, i.e. the
    recording states that its session went on under another run;
  - `resumed` — no `closed`, but the run's own conversation is recorded as bound
    to it *after* its completion (`session_opened_after_completion`) or with the
    `resumed` reason, i.e. the same run kept working on the same session;
  - `unexplained` — neither, whether or not some row names the run.

The classification is additive, so the population, the tails and the ranking of
the historical snapshot are unchanged; a reader that asks "which runs are wrong
about themselves" now gets an answer per row rather than one list.

### D4 — The build fails on an unexplained tail, but only where the record can speak

`scripts/efficiency/lib/run-window.ts` runs the shared query SQL against the
dataset this build just wrote and returns the drifting rows split by
`drift_kind` plus the workflows that recorded any session window. Every drifting
row falls in exactly one of three populations, and the build's `main()` fails —
after deleting the dataset and its README, as an empty source does — when at
least one `unexplained` row's *own* record was due. Nothing else fails:

- `judged` — the rows the record explains: `attributed` (a `closed` names the run
  the session moved to) or `resumed` (`opened` at or after the run's own
  completion, or the `resumed` reason);
- `unrecorded` — the `unexplained` rows, split by whether a record was due: a run
  that started before its workflow's first session-window event
  (`beforeRecord`) is reported and never fails, while a run that started after it
  and still has an `unexplained` tail is a **broken record** (`afterRecord`) and
  fails;
- `clock-artifact` — the rows whose own window cannot be read, counted on their
  own because their class says nothing about the session.

The counts go into the build summary under `runWindow` (`drifting`, `judged
{runs, attributed, resumed}`, `unrecorded {runs, beforeRecord, afterRecord}`,
`clockArtifact`, `unexplained`, `recordedWorkflows`), and the failure's message
names the rows, the workflow ids and the query to inspect (`analyze.ts
run-window-drift`), so the alarm explains itself.

The gate is deliberately **per run**, not per workflow and not dataset-wide: a
run is recorded iff a session-window row names *that run id*, so one run's move
cannot hide another run's lost record — the defect this alarm exists to catch is
exactly one run of a workflow recording while its neighbour does not. This is the
same shape as `source-recording`'s per-generation split, where a figure is only
read against the generation that could have recorded it.

### D5 — Cause B is classified, not fixed, and named as a limitation

Changing the traces reader to date an `agent.handoff` span by `end_nanos` would
be a defensible fix, but it rewrites what every historical trace-sourced run's
window means — the dataset's own numbers, and every comparison against the pinned
snapshot, would move for a reason that is not the change under review. The
convention stays; the query names the affected rows (`clock-artifact`) and the
docs state them, with the fix listed as a follow-up.

## Risks / Trade-offs

- **[A conversation whose turns are recorded under one run and whose *work*
  continues past the rebinding gets a `closed` record but no correction of the
  earlier run's own window]** → Accepted: the two windows are separate by design;
  the record lets a reader subtract the tail instead of silently moving the run's
  `completed_at`. A per-run "window closed" reconciliation is a follow-up, not
  this change.
- **[An alarm that fails the build on a real tail will fail the first builds after
  this change lands]** → Mitigated by the per-workflow gate (D4): only a workflow
  whose own events state a session window is judged, and the message prints the
  rows and the query. A tail in a workflow that recorded no session window
  (pre-record generations) is reported as `unrecorded` and never fails.
- **[The extra envelopes change the size of telemetry files]** → Negligible: two
  envelopes per run binding, alongside the per-turn, per-tool and per-compaction
  envelopes already written.
- **[Rebinding the identity changes historical-looking numbers for new runs only]**
  → Intended: a later run's turns become that run's, so its recorded duration and
  cost finally include the work it did. The historical dataset is untouched
  (pinned, read-only) and the change is visible as the record it now carries.
- **[A host restart between two rounds of the same step loses the turns of the
  conversation until the next `ensureRun`]** → Pre-existing, not introduced: the
  stream is attached on demand and `watchEvents` does not replay. Named in the
  architecture doc as a coverage limit of the record, not a window error.
- **[`stopRun` keeps the session binding for a retired run]** → Intended: the
  conversation is what continues, not the retired run's process. A later run on
  that conversation records `rebound` from the retired run, which is what the
  query's `attributed` class means.

## Assumptions made while implementing

Where the plan left a detail open, these were chosen and are recorded here rather
than asked about:

- **[The alarm's gate is each drifting run, not its workflow]** (`run-window.ts`,
  `queries.ts`): a run is *recorded* iff a `runtime.session_window.opened` or
  `.closed` row names **that run id** (`session_recorded`), and a workflow is not
  judged as a whole. A per-workflow gate passes an unrecorded tail merely because
  some other run of the same workflow recorded its own move — exactly the defect
  the alarm exists to catch — and it also has to guess what "the workflow records"
  means for a workflow that spans generations.
- **[A run the record does not explain is split by whether one was due]**: it
  *predates the record* when it started before its workflow's first session-window
  event (`first_session_window_at`, `lib/run-window.ts`'s `recordWasDue`); that is
  counted and never fails. A run that started after the workflow already recorded
  a window and is still `unexplained` is a **broken record** and fails the build,
  because the record should have named a continuation for it. Reporting it as
  merely unrecorded would let the alarm go quiet exactly when the recording
  regressed.
- **[`drift_kind` is decided in the order `clock-artifact` → `attributed` →
  `resumed` → `unexplained`]**: an unreadable window (`completed_at <=
  started_at`) says nothing about the session, so it wins outright (D5); then the
  record decides — `attributed` for a `closed` (the session went on under a later
  run), `resumed` for a run the record binds to itself at or after its completion
  or with the `resumed` reason; and only a run whose record states no
  continuation is `unexplained`.
- **[A binding is not a continuation on its own]** (`resumed` requires evidence,
  MIG-101): a run that was bound to its conversation *before* its own completion
  and left it without a `closed` row — a handover across a host lifetime, where
  the next binding cannot name the run it left — is `unexplained`, not `resumed`.
  Treating any binding as an explanation would make the alarm silent for exactly
  the misattribution item 20 exists to catch. The two continuation statements
  that do count are `closed` (the session moved to a named later run) and
  `opened` at or after the run's completion.
- **[The reported reason is the run's latest binding]** (MIG-103/QV-101): a
  conversation bound twice to one run reports the later move, via a correlated
  subquery ordered `at DESC`, because the reason is what a reader compares across
  runs and `MAX(reason)` would report `created` for a run that was in fact
  re-adopted after a host restart.
- **[`resumed` is a drift class, not a defect]**: the abort-and-resume path keeps
  the same run id, and the dataset still dates the run's completion at its last
  `agent.handoff`, so the turns of the resumed attempt look like a tail of the
  same run. The record is the statement that they are that run working on, and
  classifying it as `unexplained` would fail every resumed run.
- **[`tail_turns` counts turns that started after the run's recorded completion,
  and the query's threshold requires one]**: the same clock reference
  `tail_window` already used for `last_turn_at`, plus `COALESCE(tw.tail_turns, 0)
  > 0` in the outer filter, so a run whose single turn merely straddles its
  completion is not drift and the count and the measured tail cannot disagree.
- **[The alarm deletes the dataset and its README before exiting]** — the shape
  the empty-source alarm already has — so a failed build cannot leave a
  plausible-looking dataset that a later step reads as current.
- **[`runWindow` keeps the three populations apart]**: `drifting`, then `judged
  {runs, attributed, resumed}`, `unrecorded {runs, beforeRecord, afterRecord}`,
  `clockArtifact`, `unexplained` and `recordedWorkflows`. `judged` is the
  `attributed` + `resumed` rows, `unrecorded` is the `unexplained` rows (so
  `unexplained` equals `unrecorded.runs`) and `clockArtifact` is counted
  separately, because an unreadable window says nothing about the session. An
  earlier single bag of numbers made `judged` and `unrecorded` look like one
  population and left `attributed + clockArtifact + unexplained = judged` holding
  only by accident.
- **[The session-window payload travels into the dataset]**: `events` gains
  `session_reason`, `session_rebound_to`, `session_previous_run_id` and
  `session_conversation_id` (`DATASET_SCHEMA_VERSION` 3 → 4, append-only), so the
  query reports the *reason* rather than inferring it from an event name alone.
- **[The conversation id never travels as `sessionId`]**: `src/server/telemetry-parser.ts`
  maps `sessionId` to `herdr.session.id`, which is the run id for every other
  envelope; a second identifier space under the same attribute would collide. The
  window envelopes carry `herdr.session.conversation_id`.
- **[A measurement and a tool outcome are charged to their own run]**: the cost
  ceiling takes the identity the event was delivered under (the run that produced
  the message) and a tool outcome takes the run that *started* the call
  (`tool_execution_start` records the owner by `toolCallId`, `telemetry.ts`), and
  `onToolOutcome` ignores a run the host no longer tracks. Charging the bound run
  instead would let a late failure of a retired run stop whatever run happens to
  be bound now, and would let a rebinding drop the ceiling for every later run.
- **[A rebinding drains the stream for one macrotask turn]**: pi-durable publishes
  a commit's events synchronously and delivers them a microtask later, so without
  the wait a frame already committed under the leaving run would resolve the new
  identity and be re-stamped with the wrong run. The wait costs one turn of the
  event loop, once per rebinding, inside `ensureRun`.
- **[A failed `closed` record is retried, not lost]**: `emitSessionWindow` returns
  whether the append happened, and the host keeps an unwritten close per
  conversation and writes it in the same transition into the binding that now
  holds the conversation — the path that failed is the *leaving* run's, which is
  what made the write fail — or, if that fails too, on the conversation's next
  binding. A silently dropped close is precisely `unexplained` drift, which the
  alarm refuses.
- **[The whole session-window transition is serialized per conversation]**
  (CONCURRENCY-003): reading the previous binding, draining the stream, writing
  the new binding and emitting its two envelopes are one chained step, so two
  overlapping rebindings of one conversation cannot both close the leaving run —
  one of them naming a successor that never held the conversation — and cannot
  leave the last run unclosed. The pending-close queue is capped, so a
  conversation whose telemetry can never be written does not grow without bound.
- **[The producing run is resolved per event and handed to the writer]**
  (CONCURRENCY-004): `emit`-level helpers take the identity explicitly instead of
  re-resolving the current binding, so an event the stream delivers for a frame
  its run already committed is stamped with that run even if the binding moved in
  between; `runtime.tool` is emitted under the run that *started* the call
  (`callOwners`, pruned on every `tool_execution_end` and cleared on `run_end`).
  This is structural rather than synchronicity-dependent, which is what the
  drain's one macrotask turn cannot by itself guarantee.
- **[`handleFailFast` is refused for a run that no longer owns the conversation]**
  (SEC-003): a dead tool surface's supervisor used to take the bound
  conversation's environment, which after a rebinding is the successor's, and
  could abort and hand off the wrong run. It now reads the failing run's own
  context and states `herdr.fail_fast.scope: "owner-rebound"` instead.
- **[The cross-rebind producer identity is covered structurally, not by a
  deterministic test]** (TQV-102): reproducing a frame that is committed under one
  run and delivered after the binding moved needs a real durable harness whose
  publication timing is under test control, which the faux-provider harness cannot
  give; the drain makes the window one microtask wide. What is pinned instead is
  the contract the fix rests on (an envelope is written under the identity it is
  handed, never one resolved later), the serialization of two overlapping
  rebindings, and the retry of a lost close — with the limitation recorded here
  rather than papered over.
- **[The binding map's lifetime is the host process]**: like the per-conversation
  telemetry stream it exists so the conversation can attribute later turns, so it
  is dropped only at shutdown, never on `stopRun`. `stopRun` therefore also guards
  its conversation-keyed deletes by the current binding: a successor ensured while
  the abort is in flight keeps the context, ceiling state and identity it wrote.
- **[`adopted` is tested through a restart, not by reaching into the host]**: the
  test opens a file-backed host, shuts it down and opens a second host over the
  same layout, so the second host finds the run map and the conversation without a
  binding — the real condition, not a simulated one.

## Migration Plan

No migration. The record is new telemetry: a store written before this change has
no session-window events, which is exactly the `unrecorded` case (D4), and every
reader treats a missing record as "not recorded" rather than "no tail". The
dataset's `events` columns are append-only within schema 4, so a dataset built
from an older-only snapshot simply reads empty there; a dataset *file* an earlier
build wrote has no such column at all and is refused by
`assertDatasetSchemaVersion` (naming the rebuild) rather than read wrongly. A
workflow that straddles the change records some runs and not others: the runs it
recorded are judged, the ones that started before its first record are counted
`beforeRecord`, and only a run that started after that record without its own is
a failure. Rollback is the revert of one change: the envelopes stop being written,
`run-window-drift` still classifies (with every drift row `unexplained`,
`resumed`-from-a-pre-completion binding excluded, or `clock-artifact`), and the
build alarm reports the drifting runs as unrecorded-before-record instead of
judging them.

## Open Questions

None blocking. The three that a follow-up owns: (1) whether the traces reader
should date a run from the end of its handoff span (D5); (2) whether a run whose
session continued should carry a derived "effective end" in the dataset's run
rollup, which would make per-run duration match the session window everywhere
instead of leaving the tail visible but separate; and (3) whether the session
binding should be persisted in the run-map document, so a session continued
*across a host lifetime* could name the run it left instead of leaving that run
`unexplained` (D2).
