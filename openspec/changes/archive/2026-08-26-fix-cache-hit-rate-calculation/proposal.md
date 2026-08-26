## Why

The Agents panel currently overstates cache efficiency because it does not use the same prompt-token denominator as pi, and it rounds high rates to a misleading 100%. This makes per-agent telemetry inconsistent with pi's reported 96–99% cache hit rates and prevents meaningful comparison between agents.

## What Changes

- Preserve cache-write token counts from runtime usage telemetry when aggregating per-agent metrics.
- Calculate cache hit rate as cached-read tokens divided by all prompt tokens: cached-read + uncached input + cache-write tokens.
- Render the rate with decimal precision consistent with pi and keep it bounded to 0–100%, omitting it when required telemetry is invalid or unavailable.
- Add regression coverage for cache writes, high-but-not-complete hit rates, aggregation across multiple usage events, and invalid data.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-agent-metrics`: Correct the cache hit-rate inputs, denominator, precision, and omission behavior used by the Agents panel.
- `herdr-agent-telemetry`: Document and preserve cache-write usage metadata needed by downstream dashboard consumers when the runtime exposes it.

## Impact

- `agentic-coding/src/tui/dash/data.ts`: extend per-role usage aggregation with cache-write tokens.
- `agentic-coding/src/tui/dash/App.tsx`: derive and format the cache rate using pi's full prompt-token accounting.
- `agentic-coding/test/dash/data.test.ts` and `agentic-coding/test/dash/agentMetricsPanel.test.tsx`: verify calculations and rendered values.
- `agent-definitions/bridges/pi-telemetry.ts`: retain the existing runtime cache-write field contract and ensure it is covered by the dashboard calculation; regenerate the embedded agent definitions through the normal build if source changes require it.
- No external API or workflow-state changes are expected.
