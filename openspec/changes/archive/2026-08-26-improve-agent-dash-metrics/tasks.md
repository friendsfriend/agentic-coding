## 1. Correct agent metric derivation

- [x] 1.1 Update `agentMetrics()` in `agentic-coding/src/tui/dash/data.ts` to aggregate non-cached input and cached-read tokens as separate finite, non-negative values, preserving unavailable fields instead of incorporating invalid telemetry.
- [x] 1.2 Update `agentMetricLine()` in `agentic-coding/src/tui/dash/App.tsx` to calculate cache hit rate as `cacheRead / (input + cacheRead)`, omit it for missing/invalid/zero-denominator inputs, and render only a finite 0–100% value.
- [x] 1.3 Update dashboard demo telemetry in `agentic-coding/src/tui/dash/data.ts` so the corrected denominator is exercised by values where cached-read input is distinct from non-cached input and all populated metrics remain represented.

## 2. Clean up Agents panel cost and Git-status placement

- [x] 2.1 Remove the verifier-status-line cost suffix in `agentic-coding/src/tui/dash/App.tsx`, leaving cost in the compact metrics line and the existing cost breakdown only.
- [x] 2.2 Keep detail-dashboard Git health and refresh behavior backed by `worktreeGitStatus()`, while removing `gitStatus` from `WorkflowOverview` and its redundant computation in `listWorkflows()` in `agentic-coding/src/tui/dash/data.ts`.
- [x] 2.3 Remove the workspace overview Git-status panel, `G` changed-files action, changed-files modal state/keymap layer, related imports, and help entry from `agentic-coding/src/tui/dash/Home.tsx`; retain the detail dashboard Git panel and changed-file interaction.

## 3. Update focused tests

- [x] 3.1 Extend `agentic-coding/test/dash/data.test.ts` with cache-rate assertions for multiple usage events, cached-read values larger than non-cached input, and missing/negative/non-finite/zero-denominator inputs.
- [x] 3.2 Update `agentic-coding/test/dash/agentMetricsPanel.test.tsx` and relevant dashboard tests to assert the corrected cache percentage, bounded output, and exactly one rendered cost in an agent row with no cost in verification status.
- [x] 3.3 Replace workspace-overview Git-status and `G` interaction expectations in `agentic-coding/test/dash/homeOverview.test.tsx` with assertions that the overview remains usable without that panel/action, and retain or extend detail-dashboard tests in `agentic-coding/test/dash/userActions.test.tsx` for Git status and changed-file interaction.

## 4. Validate the implementation

- [x] 4.1 Run the focused dashboard test suite and verify all metric, cost-display, and Git-placement scenarios pass.
- [x] 4.2 Run `bun run type-check` and `bun run lint` from `agentic-coding/`, fixing any diagnostics introduced by the change.
- [x] 4.3 Run `openspec validate "$HERDR_CHANGE_ID" --strict` and record the validated artifacts and checks in the run output.
