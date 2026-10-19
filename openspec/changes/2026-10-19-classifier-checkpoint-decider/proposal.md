## Why

`2026-10-19-run-progress-checkpoint` ships a deterministic rule set (`rules/v1`)
as the only checkpoint decider and records every decision in the classifier
decision-record format. The developer prefers the classifier as the eventual
decider, but only once recorded decisions show it beats the rules. This
follow-up specifies that swap-in and its gate; it is a draft for a human to
promote after the primary change has shipped and produced data.

## What Changes

- A **shadow** mode: with `[agents.checkpoint] shadow = "classifier"`, every
  checkpoint also asks the configured classifier the same decision as a
  TypeSafe `choice` question over the five labels, with the content-free digest
  as its only state. The shadow answer is recorded beside the rule decision and
  never applied.
- A selectable decider: `[agents.checkpoint] decider = "rules" | "classifier"`
  (default `rules`). With `classifier`, the rule guards `hard-limit`,
  `no-progress-twice` and `steer-ignored` still decide first and cannot be
  overridden; the classifier decides only the remaining cases; a missing,
  malformed or late answer falls back to the rule decision. `confidence` is
  recorded but never consulted (the classifier contract does not gate on it).
- A **swap-in gate**: the `checkpoint-decider-eval` efficiency query pairs shadow
  and rule decisions with what happened next, and the default may switch to
  `classifier` only when the stated acceptance bar is met.
- An optional **LLM advisor**, `advisor = "off"` by default: when enabled it is
  consulted only when the classifier gives no usable answer, it must answer with
  one label of the same vocabulary (structured output, no free text), and its
  answer is recorded like any decider's.
- Every rule of the primary change holds: no turn count stops a run, a stop is a
  developer question, everything fails open, the store schema stays at 6.

## Capabilities

### New Capabilities

- `progress-checkpoint-classifier-decider`: shadow recording, the selectable
  classifier decider with non-overridable rule guards, the swap-in acceptance
  gate, and the off-by-default LLM advisor.

### Modified Capabilities

None (it builds on `run-progress-checkpoint`, introduced by the primary change).

## Impact

- `src/agent-host/progress-checkpoint.ts` and `host.ts` (shadow call and
  decider selection), the host's classifier call path (the run's existing jev
  binding / configured classifier transport), `[agents.checkpoint]` validation,
  `scripts/efficiency/lib/queries.ts` (`checkpoint-decider-eval`).
- No schema change; records keep the `progress-checkpoint` integration with the
  decider id in `model`.
