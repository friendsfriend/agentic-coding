# Proposal

## Why

Classifier routing telemetry is per-event and per-workflow: reading whether the
classifier is slow, flaky, or silently falling back to pool defaults means
opening traces and counting rows by hand. A routing pool tuned from those counts
(one label always chosen, one always below the floor) needs aggregates over many
workflows, which the trace viewer cannot express.

## What Changes

- Aggregate the routing telemetry stream into observability metrics: classifier
  call latency (histogram), classification passes and fallback count per workflow
  (sum), and provider error count by status class (sum).
- Surface those metrics in the existing Metrics view with the same filtering and
  detail affordances as the current metric families, so a routing regression is
  visible without opening traces.

## Capabilities

### New Capabilities

- `routing-metrics-aggregates`: metric definitions and Metrics-view surfacing
  for classifier routing telemetry — latency, pass and fallback counts, provider
  errors by status class, and the refresh/retention behavior they inherit.

## Impact

- `agentic-coding/src/tui/otel/model/metricStore.ts` and the telemetry database
  ingestion path that derives metrics from the workflow telemetry stream.
- `agentic-coding/src/tui/otel/views/MetricsView.tsx` /
  `MetricDetailView.tsx` for the new metric families.
- `agentic-coding/test/otel/metricStore.test.ts` and the telemetry ingest tests.
- Depends on `add-jev-classifier-telemetry` (the `routing.*` event family must
  exist before it can be aggregated).
