## Why

Two transitions a workflow makes in front of a human leave no record of
themselves, so the workflow's own history cannot explain either.

A repair (`operator.repair`) moves the engine back to an earlier step and expires
the effects and runs of the step it left. The event names the two steps and
nothing else: in the imported dataset 42 repairs across 23 workflows carry no
reason, no expired effect and no retired run, so a repair is indistinguishable
from a routine re-dispatch and a workflow that spent a night being repaired looks
idle.

A developer-blocking state — a developer question, a blocked handoff, an approval
gate — is where agent time stops and human time starts, but nothing in the event
stream marks the boundary. The question itself records when it was asked and
answered; a blocked handoff records its outcome; an approval gate records nothing
at all. Measured from the dialogue alone, 22 question waits across the imported
dataset account for 3,562 seconds of human time and the other two blocking kinds
account for none of it, and a wait still open when the workflow closes is
indistinguishable from one that ended.

## What Changes

- Record the repair with the `operator.repair` event: a bounded, redacted reason,
  the ids of the effects the repair expired, the ids of the runs it retired, and
  the workflow's repair count at that point. The same record lands on
  `snapshot.repaired` and on the workflow view's `repaired`, and the engine
  telemetry event carries the reason and the two counts.
- Emit `workflow.waiting` when a workflow enters any developer-blocking state and
  `workflow.waiting.ended` when it leaves it: the wait kind (`question`,
  `handoff`, `approval`), the subject id, and, on the end event, the elapsed
  seconds. The waits are a projection of the workflow view, derived from the
  dialogue record, the run rows and the current step's actor, so a new developer
  question kind is covered without naming it, a poll never emits an event, and a
  wait that is still open at workflow close ends at the close.
- Add two read-only efficiency queries over the imported telemetry,
  `operator-repairs-recorded` and `developer-waits`, and keep their inputs in
  append-only dataset columns.
- No behavior change: no new workflow state, no new effect, no transition, no
  schema or migration, and no change to when a workflow blocks or repairs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-engine-runtime`: an `operator.repair` now carries its cause, its
  expired effects, its retired runs, and the workflow's repair count, in the
  committed event data, the snapshot and the workflow view.
- `workflow-event-stream`: the stream now reports the developer-blocking
  boundary — one event entering a wait, one leaving it — derived from state the
  stream already observes, with no event from a poll.

## Impact

- `src/workflow/runtime/reducers/repair.ts` (the record), `src/workflow/schema.ts`
  and `src/contracts/workflow.ts` (the snapshot, view and response shapes),
  `src/workflow/runtime/view.ts` (the projection), `src/workflow/runtime/engine.ts`
  (the telemetry payload and the wait events).
- `src/workflow/runtime/waiting.ts` (new), `src/contracts/workflow-events.ts` (the
  event catalog), `src/server/workflow-events.ts` (the projection into the event
  stream).
- `scripts/efficiency/lib/{normalize,extract,dataset,queries,schema-readme}.ts`
  and the query and dataset tests; the `docs/workflow-architecture.md` repair and
  wait sections.
- `STORE_SCHEMA_VERSION` stays 6: every field is optional and additive, an older
  snapshot and an older dataset stay readable, and no migration or compatibility
  shim is introduced.
