# Proposal

## Why

The JEV/System One classifier already picks the most probable model-pool entry
for every classifiable step, but the single-select router discards that answer
whenever the answer's `confidence` is below `SINGLE_CONFIDENCE_FLOOR` (0.5) and
pins the pool's tagged `default: true` entry instead. That tagged default is the
cheapest profile in practice, so a low-confidence JEV answer is silently replaced
by a routing decision JEV never made. The user wants JEV's most probable outcome
to be authoritative at every confidence level.

## What Changes

- Remove the single-select confidence gate: `selectSingleEntry` SHALL apply the
  classifier's chosen label regardless of the answer's `confidence`.
  `SINGLE_CONFIDENCE_FLOOR` and `confidentChoice` are removed because nothing
  else consults them.
- When the answer carries no explicit `choice`, or the `choice` names no offered
  pool entry, select the offered entry with the highest `probabilities` value
  (de-duplicated by profile). Fall back to the pool's tagged `default` only when
  there is neither a usable `choice` nor usable probabilities.
- Keep `confidence` on the recorded classifier answer and in routing telemetry
  as an observed scalar; it is no longer consulted when selecting a profile.
- Explicitly unchanged: the `fusion.plan` roster `ROSTER_PROBABILITY_THRESHOLD`
  (0.2), the `TRIAGE_NOUL_FLOOR` (0.5) necessity thresholds for verifier roles
  and stage gates, the default fallback on a genuinely unusable answer, and every
  fail-open routing guard.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `classifier-model-pools`: the single-select selection requirement no longer
  gates on `confidence`; it always applies the classifier's most probable
  offered entry and only falls back when no usable answer exists.
- `classifier-routing-telemetry`: the decision record's fallback semantics
  change — a below-floor confidence is now applied, so `fallback` is reported
  only for a genuinely unusable answer, while `confidence` remains an exported
  scalar.

## Impact

- `agentic-coding/src/workflow/classifiers.ts`: `SINGLE_CONFIDENCE_FLOOR`,
  `confidentChoice`, `selectSingleEntry`, and the `buildRoutingDecisionSummary`
  fallback computation.
- `agentic-coding/src/workflow/runtime/reducers/effect-result.ts`: consumes the
  updated selector; its attention wording and decision record follow.
- `agentic-coding/src/tui/dash/demo.ts`: the demo decision record that still
  shows a below-floor default fallback.
- `agentic-coding/test/workflow-classifiers.test.ts` (and any reducer or
  telemetry test asserting the floor).
- `agentic-coding/docs/workflow-architecture.md`: one sentence on how a
  single-select profile is chosen.
- No configuration, schema, or effect-contract change: `confidence` stays a
  field of the parsed classifier answer.
