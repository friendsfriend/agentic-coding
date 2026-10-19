## 1. The repair record

- [x] 1.1 Capture the repair's cause and effect in the `operator.repair` reducer:
  the bounded reason, the expired effect ids and the retired run ids read back
  after `expireRuns`, and the repair count from the committed events.
- [x] 1.2 Carry the record on `snapshot.repaired`, pass it into the workflow view
  and through `workflowViewSchema` as an optional additive field, and extend
  `repairedSchema` with the same optional fields.
- [x] 1.3 Read the committed event data in the engine's `operator.repair`
  telemetry branch and export the reason, the two counts and the repair count,
  omitting an empty reason.

## 2. Repairs in the dataset and the docs

- [x] 2.1 Map the record from both sources — the store's event data and the
  telemetry fields — into the append-only dataset columns `repair_effects`,
  `repair_runs` and `repair_count`, with the reason in `detail`.
- [x] 2.2 Add the `operator-repairs-recorded` query, cover it with a focused
  synthetic-dataset test and one dataset test per source, and record the record's
  fields, its bounds and the query in `docs/workflow-architecture.md`.

## 3. Developer waits

- [x] 3.1 Project the wait from the workflow view — kind, subject and start —
  with the precedence question over handoff over approval, and no wait while the
  workflow is completed or closed.
- [x] 3.2 Compute the wait before the command commits, so the run rows the
  projection reads are the pre-transition ones.
- [x] 3.3 Emit `workflow.waiting` on entering a wait and its subject changing, and
  `workflow.waiting.ended` on leaving one, once per transition and never per poll.
- [x] 3.4 Add both events to the versioned catalog with their payload schemas, and
  project them into the workflow event stream from the view's wait.

## 4. Waits in the dataset and the docs

- [x] 4.1 Carry `wait_kind` in the dataset and pair each `workflow.waiting` with
  its `workflow.waiting.ended` row.
- [x] 4.2 Add the `developer-waits` query — agent seconds against human wait
  seconds per workflow, with the recorded wait preferred over the reconstructed
  question wait — cover it with a focused synthetic-dataset test, and record it in
  `docs/workflow-architecture.md`.

## 5. Verification

- [x] 5.1 Repair tests: the record's fields, a repair without a reason, a repair
  count over repeated repairs, a reason that is truncated and redacted, and a
  telemetry payload that carries counts and no ids.
- [x] 5.2 Wait tests: each blocking kind opens and closes a wait, an approval gate
  waits from the step's entry, a blocked run is the wait and outlives the
  attention edge, a re-entered gate and a poll emit nothing, an expiry ends the
  wait, a wait open at workflow close ends at the close, and the catalog version
  and the payload schemas.
- [x] 5.3 `bun run type-check` 0 errors, `bun run test` passes, `bun run lint` is
  clean on the changed files, and `openspec validate --changes --strict` passes.
