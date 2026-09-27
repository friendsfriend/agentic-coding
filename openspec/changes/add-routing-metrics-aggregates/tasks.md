# Tasks

## 1. Aggregates

- [ ] 1.1 Derive routing latency, pass/fallback, and provider-error-by-status-class aggregates from the routing events in `agentic-coding/src/tui/otel/model/metricStore.ts`, and verify with `agentic-coding/test/otel/metricStore.test.ts` that a successful pass contributes one latency point and one pass point, and a `5xx` response contributes exactly one error point under `5xx`.
- [ ] 1.2 Verify the missing-field rule in `agentic-coding/test/otel/metricStore.test.ts`: a routing event that omits `durationMs` or the fallback count contributes to no aggregate for that field and does not report a zero.

## 2. Surfacing

- [ ] 2.1 Render the routing metric families in `agentic-coding/src/tui/otel/views/MetricsView.tsx` and their detail in `MetricDetailView.tsx` with the existing filtering affordances, and verify with a focused view test that each routing metric is listed, selectable, and shows its data points.

## 3. Checks

- [ ] 3.1 Run `bun run lint`, `bun run type-check`, and the focused `bun test test/otel/metricStore.test.ts` in `agentic-coding/` with zero diagnostics.
