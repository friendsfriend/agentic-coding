## Why

The dash Agents panel currently shows only role, status badge, model, and (for verifiers) cost. Users comparing agents across runs have no visibility into how expensive, fast, or cache-efficient each agent is, and the runtime telemetry bridge omits cache and timing detail so these metrics cannot be tracked through the OTel pipeline either.

## What Changes

- Extend the pi telemetry bridge's usage event (`runtime.usage`) to include cache read/Write token counts, per-message duration, and derived tokens-per-second so every metric shown in the panel is also exported via the existing OTLP log export.
- Normalize usage-event naming so dashboard cost/metric aggregation (`costSummary`) sees runtime usage events regardless of which runtime bridge emitted them (`runtime.usage` vs `model_usage`).
- Aggregate per-agent metrics in the dash data layer: total cost, input/output tokens, cache hit rate (cache-read tokens / total input tokens), run duration (first agent start → last settled/usage event), and output tokens per second.
- Restructure the Agents panel rows in the workflow dash to display these metrics compactly for each agent (single extra metric row, bounded/truncated so panel layout does not break).
- Extend demo/test data to exercise all new metric fields.

## Capabilities

### New Capabilities
- `dashboard-agent-metrics`: Compact per-agent performance and cost metrics (cost, tokens in/out, cache hit rate, run duration, tokens/s) displayed in the dash Agents panel.

### Modified Capabilities
- `herdr-agent-telemetry`: Usage telemetry events SHALL carry cache token counts, message duration, and tokens-per-second alongside existing token/cost metadata so agents' efficiency is trackable via OTel exports.

## Impact

- `agent-definitions/bridges/pi-telemetry.ts` — emit extended usage fields; regenerate `src/workflow/embedded.generated.ts` via `bun run build`.
- `agentic-coding/src/tui/dash/data.ts` — new per-role metric aggregation feeding `DashboardData.agents`.
- `agentic-coding/src/tui/dash/App.tsx` — Agents panel row rendering.
- `agentic-coding/src/tui/dash/ui/EventsModal.tsx` — optional label/detail for new usage fields.
- No new dependencies; no breaking API changes.
