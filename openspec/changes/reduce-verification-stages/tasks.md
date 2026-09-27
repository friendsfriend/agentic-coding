# Tasks

## 1. Decision signal

- [ ] 1.1 Add a bounded "complete suite warranted" necessity question to the per-round classifier request, reusing the existing routing step and endpoint. Verify with a focused classifier test asserting the question travels in the same single request and uses the same 0.5 gate.
- [ ] 1.2 Resolve the round's suite decision (run / skip) from the answer, defaulting to run on a missing, malformed, or failed signal, and record the decision with its reason on the round. Verify with a focused reducer test for a skip decision, a run decision, and a fail-open default.

## 2. Launch condition and visibility

- [ ] 2.1 Make the engine's automatic launch of the full-suite role conditional on the round's recorded decision, keeping the once-per-round and already-ran guards unchanged. Verify with a focused step test for both a skipping and a non-skipping round.
- [ ] 2.2 Surface the reduction decision in the developer view and round record. Verify with a focused view test asserting a skipped round is distinguishable from a full round and names the deciding signal.

## 3. Developer override

- [ ] 3.1 Add developer actions to request the suite for a reduced round and to accept a reduced round, both recorded on the round and reusing the existing launch path. Verify with a focused test that a requested suite run launches the full-suite role and that an accepted reduced round can pass.
- [ ] 3.2 Run `bun run lint`, `bun run type-check`, and `bun run build` in `agentic-coding/` with zero diagnostics, plus the focused workflow step, reducer, and view suites. Verify: clean runs and no failing test.
