# Proposal

## Why

Classifier-driven verifier role selection still always runs the complete test
suite: a documentation-only or configuration-only change can select zero domain
verifiers, but `test-verifier` is auto-launched and the round cannot pass without
it. That leaves the most obviously wasteful stage as the one stage the workflow
refuses to skip, so a trivial change pays for a full repository suite.

## What Changes

- Make stage reduction explicit and auditable instead of implicit: the engine
  decides, per round, whether the complete suite runs, instead of always running
  it.
- Extend the per-round classification with a bounded "is the complete suite
  warranted" signal (documentation/config-only vs. behaviour-changing), so the
  decision is deterministic, recorded, and visible in the round's evidence.
- When the suite is skipped, the round still must be verifiable: the decision is
  recorded on the workflow, surfaced in the developer view, and the skipped
  stage remains re-runnable on demand.
- **BREAKING**: a round that skips the suite no longer launches
  `test-verifier`; workflows that relied on the suite always running need
  configuration that opts into running it.

## Capabilities

### New Capabilities
- `reduced-verification-stages`: per-round decision, recording, and developer
  opt-in for running the complete test suite.

### Modified Capabilities
- `workflow-verifier-role-coverage`: the automatic launch of the engine-owned
  full-suite role becomes conditional on the round's recorded reduction
  decision.

## Impact

- `agentic-coding/src/workflow/steps/verification.ts` (launch condition and the
  round's reduction decision).
- `agentic-coding/src/workflow/classifiers.ts` /
  `classifier-runner.ts` (the additional necessity question and its answer).
- `agentic-coding/src/workflow/runtime/reducers/effect-result.ts` (recording the
  decision and the attention entry when the signal is unusable).
- The developer/dashboard view that reports what ran for a round.
- Depends on `classifier-driven-triage-routing` for the per-round routing step.
