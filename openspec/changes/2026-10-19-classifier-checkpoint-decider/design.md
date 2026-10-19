## Context

The primary change records each checkpoint as a `progress-checkpoint` classifier
decision record (`model` = `rules/v1`, a `choice` answer with one-hot
probabilities) and as a `runtime.checkpoint` envelope. The classifier today
(`src/workflow/classifiers.ts`) answers a `choice` question with `choice`,
`probabilities` and `confidence`; selection takes the explicit choice, else the
most probable offered label, else the tagged default; `confidence` is recorded
and never consulted; an unusable answer degrades to "no answer". It reads a
bounded text state and writes no free text.

## Goals / Non-Goals

**Goals:** collect paired rule/classifier decisions without risk; define when
the classifier may become the default; keep the safety rails of the rules.

**Non-Goals:** confidence gating; letting any decider write free text; acting on
`switch-model`; turning the advisor on by default.

## Decisions

- **Shadow before switch.** Shadow answers go into the `runtime.checkpoint`
  envelope (`shadow: {decider, choice, probabilities, latencyMs, status}`) and,
  for the first 12 checkpoints of a run, into a second decision record with
  `model` = the classifier model and `result.applied = false`. A shadow failure
  is recorded and ignored.
- **Guards stay rules.** `hard-limit`, `no-progress-twice` and `steer-ignored`
  are evaluated before the classifier and are final; this keeps "the hard limit
  and two zero-progress continues always escalate" independent of a model.
- **Steer stays the catalog.** A classifier `steer` maps to the catalog nudge of
  the strongest present signal (fixed order: failing-tool, repeats, no-progress,
  cost-rising); with no signal present it is recorded as not applied and the run
  continues. A classifier `compact` that is not admissible is not applied.
- **No answer → rules.** A missing, malformed, late (10 s bound) or
  non-vocabulary answer applies the rule decision; the record says so.
- **Acceptance gate.** `checkpoint-decider-eval` labels each shadowed checkpoint
  with the next window's progress, the run's outcome and cost to completion. The
  default may switch to `classifier` only when, over at least 200 shadowed
  checkpoints from at least 50 runs: (1) the classifier's escalations per 100
  runs are no higher than the rules'; (2) its `steer`/`compact` choices are
  followed by a progress event in the next window at least as often as the
  rules'; (3) on runs that ended `blocked` or `failed` after their soft
  threshold, the classifier's first non-`continue` decision comes no later
  (median turns) than the rules'. The switch itself is a configuration default
  change reviewed with that evidence.
- **Advisor is a documented fallback.** `advisor = "off"` by default; when set,
  it is consulted only after a classifier no-answer, with the digest only, and
  must return one vocabulary label; anything else falls back to the rules.

## Risks / Trade-offs

- [Classifier latency on the run's critical path] → shadow first; 10 s bound;
  fail-open to the rule decision.
- [Too few recorded checkpoints to judge] → the gate states minimum counts; the
  default does not change until they are met.
- [Model drift after the switch] → shadow the rules under `decider =
  "classifier"` too, so the eval keeps running.

## Migration Plan

None: configuration defaults keep today's behaviour (`decider = "rules"`, no
shadow, advisor off).

## Open Questions

- Whether a probability-margin rule (e.g. top label below a pinned margin →
  rule decision) is worth adding once shadow data exists.
