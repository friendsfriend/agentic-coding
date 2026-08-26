## Context

The workflow detail dashboard (`src/tui/dash/App.tsx`) already renders one compact metric line from `agentMetrics()` and also appends `agent.cost` to a verifier's status line. The metric formatter currently divides aggregated `cacheReadTokens` by `inputTokens`. The telemetry bridge emits these as separate values: `usage.input` is the non-cached input count while `usage.cacheRead` is the cached portion. A cached prompt can therefore be much larger than the uncached input and produce percentages far above 100%.

The main workflow workspace overview (`Home.tsx`) currently owns a second Git-status presentation, including a selected-workspace status panel and a `G` changed-files modal. The detail dashboard already derives Git health from the shared `worktreeGitStatus()` helper and renders a Git status panel with Enter-driven changed-file/review interaction. The requested placement is therefore a removal of the duplicate overview presentation, not a new Git inspection implementation.

## Goals / Non-Goals

**Goals:**

- Derive cache-hit rate from the two separate input components as `cacheRead / (input + cacheRead)`, aggregate values by role, and render only finite percentages in the inclusive 0–100% range.
- Treat missing, negative, non-finite, or zero-denominator cache inputs as unavailable instead of inventing a percentage.
- Make the compact Agents metrics line the sole agent-panel display of cost; verification status remains responsible only for verdict, duration, and fallback state.
- Keep Git status, refresh, and changed-file interaction in the detail dashboard while removing them from the workspace overview and its overview-specific data contract.
- Preserve bounded rendering and existing shared Git inspection behavior.

**Non-Goals:**

- No changes to the telemetry bridge schema, workflow state, cost breakdown modal, Git classification rules, or external APIs.
- No changes to the dashboard's existing detail-panel keyboard model beyond what is needed to retain its Git panel behavior.
- No attempt to reinterpret historical telemetry beyond applying the corrected aggregation when it is loaded.

## Decisions

### 1. Use uncached-plus-cached input as the cache-rate denominator

`inputTokens` and `cacheReadTokens` are separate usage components in the runtime telemetry. Aggregate both per role, then calculate `cacheReadTokens / (inputTokens + cacheReadTokens) * 100` only when both components are valid and the denominator is positive. Round to the existing whole-percent display format. This makes the metric mathematically bounded and represents the fraction of all input tokens served from cache.

The alternative—continuing to divide by `inputTokens`—is rejected because it treats only uncached input as the total and can produce the reported impossible values. A raw percentage clamp without correcting the denominator is also rejected because it hides bad semantics rather than measuring cache share correctly.

Validation belongs at the aggregation/formatting boundary: only finite, non-negative numeric telemetry contributes to the aggregates, and the formatter omits the cache field when either required component is unavailable. A zero cache-read value remains valid and renders `0% cached` when positive input is available.

### 2. Keep cost in the metrics line only

Retain the existing aggregated cost in `AgentUsageMetrics` and `agentMetricLine()`, and remove the conditional cost suffix from the verifier timeline/status text in the Agents row. This gives the row one authoritative compact cost value while preserving the separate cost breakdown action.

The alternative of removing cost from the metrics line is rejected because the metrics line is the stable comparison surface and already contains the other usage metrics. Removing the cost field from the data model is also rejected because the cost breakdown and existing consumers use it.

### 3. Move ownership of Git status to the detail dashboard

Continue using `worktreeGitStatus()` when `loadDashboard()` builds `DashboardData.health`; this keeps branch, dirty, ahead, and behind values in the agent-dash TUI. Remove `gitStatus` from `WorkflowOverview`, stop computing it in `listWorkflows()`, and remove the Home status line/panel, `G` binding, changed-files modal state, and Home-specific keymap layer. The shared helper and detail-dashboard Git panel remain intact.

The alternative of maintaining both views is rejected because it duplicates polling and presents the same concern in the wrong top-level screen. Moving the helper into a new module is unnecessary because the detail dashboard already consumes it.

### 4. Test the behavior at both pure-data and rendered-UI levels

Extend `data.test.ts` with cache-rate cases where cached input is larger than uncached input, plus missing/invalid input cases. Update the Agents panel test fixture and expected percentage to the corrected denominator, and assert that the verification status does not repeat the cost. Replace overview Git-status assertions with an explicit absence/normal-overview assertion, while retaining or extending detail-dashboard Git panel tests for status and changed-file interaction.

## Risks / Trade-offs

- [Risk] Existing demo percentages and snapshots encode the old denominator. → Mitigation: update fixtures and assertions to use a deliberately distinguishable corrected value, and test a cache-read value larger than uncached input.
- [Risk] Treating malformed telemetry as unavailable can hide data-quality problems. → Mitigation: keep cost/token aggregation tests and add explicit invalid-input coverage; do not substitute zero values.
- [Risk] Removing Home's `G` interaction may surprise users who used it from the overview. → Mitigation: keep the interaction in the detail dashboard, document the placement through the dashboard help/tests, and keep overview workflow switching intact.
- [Risk] Git status could be computed more often or less often after the move. → Mitigation: preserve the existing detail-dashboard refresh path and shared synchronous helper; remove only the redundant overview computation.

## Migration Plan

1. Update the delta specs and implement data aggregation/formatting changes.
2. Remove overview Git-status fields and UI/keymap wiring; retain detail-dashboard health and panel behavior.
3. Update pure-data and TUI tests, then run the repository's type-check, lint, and dashboard test suites.
4. Rollback is a code revert. No persisted data or telemetry migration is required; old telemetry remains readable with unavailable cache percentages when its required fields are not valid.

## Open Questions

- None blocking implementation. The runtime telemetry contract is treated as authoritative: `inputTokens` is non-cached input and `cacheReadTokens` is a separate cached-input count.
