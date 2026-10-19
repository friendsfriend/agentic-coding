## Why

A run's session outlives the run, and nothing records it: 156 of the 1,259
preferred runs in the pinned snapshot (12.4 %, in 38 workflows) carry turns after
their own recorded completion — median tail 1,032 s (median-high), p90 5,748 s
(nearest rank), max 63,380 s —
and those 156 runs hold 14,163 turns, 11,960 of which start after the run's own
recorded completion (34.4 % of the 34,711 the snapshot records; the turn counts
are pre-repair and not a ratio of the cost denominator) and 114.50 of the
repaired 441.9321 preferred cost units (25.9 %). A run recorded `complete` with a
6-minute window labels 17 minutes of later work, and 315 of 1,259 runs (25.0 %)
record no turns at all because their work is attributed to an earlier run of the
same step and role. Status, duration and cost per run are therefore wrong for a
quarter of the run rows, which is the input of every "cost per run", "stalled
run" and "cost per minute" answer.

The cause is measured, not inferred. The durable host keys one pi-durable
conversation per canonical agent name — `(workflow, step, role)`, which is stable
across rounds and attempts — and attaches the runtime telemetry stream once, with
the identity of the run that created it. Every later run served by that
conversation is stamped with the first run's id, so its turns land after that
run's `agent.handoff`. In `add-definition-family-traits` (2026-10-06) the
`migration-verifier` conversation settles twice: the attempt-1 run
`d4c2724b` closes at 14:03:04 and carries the attempt-2 work until 14:20:03,
while the attempt-2 run `9739791f` (14:14:33 → 14:19:53) records zero turns.
`run-window-drift`, restored in backlog item 0, reports the population; nothing
fails a build on it, and no record explains a tail as a legitimately continued
session.

## What Changes

- Record the session window next to the run window instead of closing a run when
  its session stops. The durable host emits two runtime envelopes on a
  conversation's run binding: `runtime.session_window.opened` when a run is bound
  to the conversation (reason `created`, `rebound`, `adopted` or `resumed`) and
  `runtime.session_window.closed` on the run it leaves when a different run
  rebinds it, naming the run it rebinds to. Both carry the conversation id as the
  conversation id as `herdr.session.conversation_id`, never as the envelope's
  `sessionId` (that field means *run* id everywhere else); neither writes any
  workflow state.
- Rebind the conversation's runtime telemetry identity to the run that is
  actually active, so a turn emitted after a rebinding is attributed to the run
  that was working. The envelopes of one stream therefore carry the run current
  at emission rather than the run that created the conversation, and the 25 % of
  runs that currently record no turns record their own.
- Make `run-window-drift` classify every tail and carry the count of turns in it:
  `attributed` (the run's session is recorded as rebound to a later run),
  `resumed` (the run's own conversation is bound to it at or after its completion,
  or with the `resumed` reason), `clock-artifact` (the run's recorded completion
  precedes its own start, i.e. the traces source's span-start convention) or
  `unexplained`. A binding that predates the run's own completion is not a
  continuation, so it stays `unexplained`.
- Make the dataset build fail on a tail no record explains instead of recording a
  note, the way an empty source already fails it: the gate is each drifting run
  (a run is recorded iff a session-window row names *its* run id), a run that
  began before its workflow's first record is counted `unrecorded.beforeRecord`,
  a run that began after it without its own record fails as
  `unrecorded.afterRecord`, and a failed build writes no dataset. The summary
  keeps `judged`, `unrecorded` and `clockArtifact` apart.
- No `STORE_SCHEMA_VERSION` change (stays 6), no migration, no compat shim, and
  no change to when a workflow blocks, completes or resumes: the record travels
  in the telemetry envelope, and a resumed session keeps its run.

## Capabilities

### New Capabilities

- `run-window-integrity`: the analysis surface of the two windows — how
  `run-window-drift` classifies a tail and what the dataset build refuses to
  write.

### Modified Capabilities

- `durable-agent-host`: a reused conversation rebinds its runtime telemetry
  identity to the run now active and records the session window around it.
- `herdr-agent-telemetry`: the runtime stream's envelopes carry the run current
  at emission, and the two session-window envelopes describe a conversation's run
  bindings.

## Impact

- `src/agent-host/host.ts` (the binding and the two emissions in `ensureRun`),
  `src/agent-host/telemetry.ts` (a stream's identity is resolved per envelope,
  and the session-window envelopes are emitted through the same sink).
- `scripts/efficiency/lib/queries.ts` (`run-window-drift`'s classification and
  turn count), `scripts/efficiency/lib/extract.ts` (the event class of the two
  new events), `scripts/efficiency/build-dataset.ts` plus a new
  `scripts/efficiency/lib/run-window.ts` (the build alarm).
- `docs/workflow-architecture.md` (the session window and why the run window is
  unchanged), `docs/efficiency/01-dataset-tooling.md` (the query's new columns).
- Not touched: the workflow store, the engine's run lifecycle, `engine.ts`,
  `embedded.generated.ts`, the CSV and number formats, and the pinned snapshot
  (read only).
