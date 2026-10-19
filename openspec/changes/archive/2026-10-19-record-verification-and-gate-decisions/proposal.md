## Why

Two decisions a workflow makes every round are not measurable after the fact.
The engine decides which verifier roles a round needs, runs the round, and
decides through two gates whether the round happens at all — but the round's
outcome exists only as a snapshot field that the next transition overwrites, and
a gate verdict exists only in the snapshot's bounded `gateDecisions` list and, on
an actual skip, in the `gate.skip` event. Evidence from 121 rounds reconstructed
from run timing shows the gap: the round boundary had to be inferred from
timestamps, and a stage whose gate has skipped every evaluation is
indistinguishable from one whose gate never ran.

## What Changes

- Emit one `verification_round` engine telemetry event per verification round
  that ends: round index, `findings`/`none`/`abandoned`, participating runs and
  roles, the critical count, the locked role selection, and the round's planned
  file→role map as counts plus a digest.
- Emit one `triage.plan.selected` engine telemetry event per round that reaches a
  role selection, naming the path that produced it (`classifier`, `default`,
  `legacy-agent`, `empty-bypass`) with the same bounded file→role form.
- Emit one `gate.decision` engine telemetry event per gate evaluation: stage,
  `run`/`skip`, resolved policy (`auto`/`always`), forced-or-answered, the
  classifier's `noul` when there was one, and the measured classification
  latency. `gate.skip` stays exactly as it is.
- Add two read-only efficiency queries over the imported telemetry,
  `verification-rounds-recorded` and `gate-decisions`, and classify
  `triage.plan.selected` as a triage event in the dataset extractor.
- No behavior change: no new workflow state, no new effect, no transition, no
  schema or migration, no change to `snapshot.gateDecisions`, and no change to
  the routing or triage decisions themselves.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `classifier-routing-telemetry`: the same engine telemetry stream now also
  carries the round's selection, the round's outcome, and each gate evaluation,
  under the same bounded, content-free, observational-only contract.

## Impact

- `src/workflow/steps/types.ts` (a completion may carry bounded telemetry),
  `src/workflow/steps/{gates,routing,verification}.ts` (the payload builders),
  `src/workflow/runtime/reducers/{agent-handoff,effect-result}.ts` (the records
  travel with the completion), `src/workflow/runtime/engine.ts` (one engine
  event per record, plus the abandoned round the runtime still sees).
- `scripts/efficiency/lib/{queries,extract}.ts` and the query test; the
  `docs/workflow-architecture.md` decision-telemetry section.
- `STORE_SCHEMA_VERSION` stays 6; no migration and no compatibility shim.
