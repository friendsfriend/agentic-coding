## 1. Records on the completion

- [x] 1.1 Let a step behavior's completion carry bounded telemetry records
  (`CompletionTelemetry`, `CompletionResult.telemetry`) and pass them through the
  handoff and effect-result reducers into the committed event data, with the
  step's presence on the definition available to a behavior as
  `hasStep(stepId)`.
- [x] 1.2 Emit one engine telemetry event per record after the command commits,
  next to the existing `routing.classified`/`gate.skip` emission, so a commit
  that produces both a plan and a gate decision reports both.

## 2. The three events

- [x] 2.1 `verification_round` from `core.verification`'s completion: round
  index, `findings`/`none`, runs, roles, critical count, locked role selection,
  and the plan's file→role counts plus digest — once per round that ends, and
  never for an open or gate-skipped round.
- [x] 2.2 `triage.plan.selected` from `core.triage`'s completion, naming the path
  (`classifier`, `default`, `legacy-agent`) with the same bounded file→role form,
  and from `core.triage-route` for the zero-role `empty-bypass` verdict, which
  runs no triage step.
- [x] 2.3 `gate.decision` from the shared gate payload used by `core.triage-route`
  and every stage gate: stage, decision, policy, forced, `noul`, with the
  classification's measured duration as the event's latency; `gate.skip` left
  unchanged.
- [x] 2.4 Record the round a failed verifier run abandons, from the runtime that
  still sees the round's run rows, without inventing the plan map or a critical
  count the commit has already reset.

## 3. Queries and docs

- [x] 3.1 Add `verification-rounds-recorded` (recorded rounds against rounds
  reconstructed from run timing, per source) and `gate-decisions` (the run/skip
  split per gate step, per source) to the ready-made queries, and classify
  `triage.plan.selected` as triage in the dataset extractor.
- [x] 3.2 Cover both queries with a focused synthetic-dataset test and record the
  three events, their payload keys, the omitted fields, and the two queries in
  `docs/workflow-architecture.md`.

## 4. Verification

- [x] 4.1 Engine tests: exactly one round event per round (a findings round and a
  clean round through the engine-owned suite), a gate decision for `run` and for
  `skip`, each selection path, the abandoned round, and a 300-file plan that
  exports counts and one digest and no path.
- [x] 4.2 Step tests: the plan's `source` for a classifier selection, a fail-open
  arrival, and a definition without the routing step, plus the bounded payload.
- [x] 4.3 `bun run type-check` 0 errors, `bun run test` passes, `bun run lint` is
  clean on the changed files, and `openspec validate --strict` passes.
