## Why

`paneForRunFactory` (`src/workflow/cli.ts`) reuses a live agent's existing pane whenever one resolves, but `agentEffectHandlers`'s `agent.launch` handler (`src/workflow/effect-runner.ts`) unconditionally calls `pane close` on any `adapter.launch()` failure. When a launch is retried into a reused pane and the retry fails, the handler destroys a pane that belongs to a different, still-live agent — observed in production when a failed `test-verifier` launch on `wM:p7` destroyed the completed `quality-verifier` pane. This risks silently discarding other verifiers' completed work mid-round.

## What Changes

- Change the pane-allocation result returned by `paneForRunFactory` (and the `paneForRun` contract consumed by `agentEffectHandlers`) to report whether the call created the pane or reused an existing one.
- Panes obtained by reuse (a live agent's resolved pane, or an existing sibling pane discovered via layout inspection) are marked as not created by this call.
- Panes obtained by `tab create` or `pane split` are marked as created by this call.
- On `adapter.launch()` failure, the `agent.launch` effect handler closes the pane only when this launch call created it; a reused pane is left untouched regardless of launch outcome.
- Add regression tests covering: launch failure on a reused pane does not close it; launch failure on a newly created pane still cleans it up; and normal verification/test-verifier phase advancement is unaffected.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-pane-identity`: the "Reuse before spawn" requirement gains a launch-failure cleanup rule so that reused panes are never closed as a side effect of a failed launch attempt on that pane.

## Impact

- `src/workflow/cli.ts` — `paneForRunFactory` return shape gains an ownership flag on every return path (resolved live agent, sibling/bottom-row reuse via layout inspection, `pane split`, `tab create`).
- `src/workflow/effect-runner.ts` — the `AdapterEffectOptions.paneForRun` type and the `agent.launch` handler's failure-cleanup branch.
- `test/workflow-cli.test.ts` and/or `test/workflow-effects.test.ts` — new focused regression tests for the ownership-gated cleanup behavior.
- No changes to persisted workflow state, run handles, or the reuse-before-spawn resolution logic itself (`resolveLiveAgent`, canonical naming) — only the failure-path cleanup decision changes.
