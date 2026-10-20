## 1. Measurement first

- [x] 1.1 Add the `turn-distribution` query to `scripts/efficiency/lib/queries.ts` (per checkpoint class: runs, p50/p90/p95/p99/max turns for all runs and for successful runs — handoff outcome `complete` or run status `complete`/`completed` — and the outcome coverage), with a fixture test in the existing query test file
- [x] 1.2 Build the dataset from the latest snapshot into a temporary directory (`build-dataset.ts --evidence ~/agentic-coding-efficiency-evidence/latest --out "$(mktemp -d)/ds"`), run `turn-distribution`, and apply the design's D3 formula to pin `softTurns`/`hardTurns` per class; record the table, the formula, the outcome coverage and the repaired-denominator figures (441.9321 units, 34,711 turns, 26,847 calls, 1,259 runs) in a new addendum `docs/efficiency/04b-run-progress-checkpoint.md` without rewriting the older documents
- [x] 1.3 Add the `run-progress`, `progress-checkpoints` and `checkpoint-gaps` queries with fixture tests (a run past its soft threshold with no or only errored `runtime.checkpoint` envelopes appears in `checkpoint-gaps`; second-half/first-half ratio computed per run)

## 2. Pure checkpoint module

- [x] 2.1 Create `src/agent-host/progress-checkpoint.ts`: the per-run signal accumulator (turns, cost units, context/peak, failing-tool streak after a first success, exact-repeat share over the last 20 calls, turns since progress, cost-rising ratio), the content-free digest, and the per-class threshold resolution with the pinned defaults
- [x] 2.2 Implement the ordered `rules/v1` rule set (hard-limit, no-progress-twice, steer-ignored, context→compact when admissible, failing-tool, repeats, no-progress, cost-rising, default) as a pure function of the digest, plus the closed, versioned steer catalog and the templated escalation summary
- [x] 2.3 Unit tests for the module: each rule fires on its minimal digest and not otherwise; the same digest gives the same decision; `steer = false` turns steer rules into `continue`; a steered signal that returns escalates; the digest and the escalation text contain no path, argument, error text or message text (assert on a digest built from calls carrying such content); the failing-tool signal is absent for exempt roles and for zero-success runs

## 3. Recording in the engine

- [ ] 3.1 Add the step-declared checkpoint class to the registered step behaviors and pass it to the run environment as `HERDR_CHECKPOINT_CLASS`; test that a worker, a planner, a verifier and a mechanical step carry their class and an undeclared step carries none
- [ ] 3.2 Add the authenticated `workflow checkpoint --record <json>` run command and its reducer: validate the bounded record, append one `progress-checkpoint` classifier decision record within the existing schema, commit an event with no lifecycle transition, refuse a run that is not active; tests for append, refusal and unchanged lifecycle state; `STORE_SCHEMA_VERSION` stays 6
- [ ] 3.3 Give the dashboard classifier panel a one-line outcome for the `progress-checkpoint` integration (`decided <label> (rule <id>)`) with a projection test

## 4. Host wiring

- [ ] 4.1 Extend the tool observation in `src/agent-host/telemetry.ts` with the argument hash and a mutation flag, and `runtime.settled` with `costUnits`, `checkpoints` and `checkpointEscalations`; update the telemetry tests
- [ ] 4.2 Wire the checkpoint into `host.ts` beside the fail-fast monitor (only for runs with a run id and `[agents.checkpoint] enabled`), sampling diff numbers, `HEAD` and the ticked-task count only at checkpoints with a 2 s bound; apply `continue`, `steer` (host `steer` submit mode), `compact` (ceiling admission, kind `auto-checkpoint`) and `switch-model` (recorded `applied: false`); emit one `runtime.checkpoint` envelope per checkpoint and record the first 12 through the run command
- [ ] 4.3 Implement escalation: file the developer question as the run with the templated summary, keep the run going during the grace window, then apply answered (fixed message + wrapped custom text, baseline reset), cancelled (stop at a turn boundary, `blocked` handoff naming the question), pending (stop at a turn boundary, `blocked` handoff naming the pending question) or filing-failed (continue); emit `runtime.checkpoint_escalation`
- [ ] 4.4 Wrap every evaluation and action in the fail-open guard and test with a fake harness: an evaluation that throws, a failed record write, a failed `git` sample and a failed question each leave the run running and emit `status: "error"`; a run never stops on a threshold alone; an escalation without a recorded question never stops a run; the answered-in-time path keeps the session

## 5. Configuration and documentation

- [ ] 5.1 Parse and validate `[agents.checkpoint]` (`enabled`, `steer`, `contextTokens`, per-class `softTurns`/`hardTurns` with `softTurns ≥ 10` and `hardTurns ≥ 2 × softTurns`) in `src/workflow/profiles.ts` and hand it to the host; validation tests for valid, invalid and absent tables
- [x] 5.2 Add `scripts/efficiency/replay-checkpoint.ts` that feeds recorded turns and calls from a dataset into the same pure module and prints per-run would-be decisions and argument-hash coverage; record in the 04b addendum what it decides for the 1,072-turn run and for the 704–1,010-turn successful runs
- [ ] 5.3 Document the checkpoint (classes, defaults, rules, steer catalog, escalation, fail-open, records, queries) in `docs/workflow-architecture.md` and the `[agents.checkpoint]` section in the configuration documentation

## 6. Focused verification

- [ ] 6.1 Run the focused tests of the touched modules only (progress-checkpoint, telemetry, host checkpoint wiring, the checkpoint run command/reducer, profiles validation, dashboard projections, efficiency queries) with a temporary `HOME`, `AGENTIC_CODING_CONFIG_DIR` and `HERDR_WIKI_DIR`, never against the real store or configuration
- [ ] 6.2 `bun run lint` and `bun run type-check` from `agentic-coding/` end clean, and `openspec validate 2026-10-19-run-progress-checkpoint --strict` passes
