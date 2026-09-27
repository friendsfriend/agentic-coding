# Design

## Context

See `proposal.md` — Why. The routing event family (`routing.request`,
`routing.response`, `routing.classified`) is introduced by
`add-jev-classifier-telemetry` and carries bounded numeric scalars
(`durationMs`, status class, step counts, fallback count, confidence). The metrics
surface already exists: `agentic-coding/src/tui/otel/model/metricStore.ts` with
`MetricsView` / `MetricDetailView`, fed from the same telemetry stream that backs
the trace store.

## Goals / Non-Goals

**Goals:** cross-workflow routing aggregates that reuse the existing metrics
store and views.

**Non-Goals:** no new collector or export protocol, no per-label routing
distribution metric (labels are unbounded vocabulary), no change to the routing
event payloads.

## Decisions

- Derive aggregates in the existing metrics store from the same parsed events
  the trace store consumes, rather than introducing a second ingestion path.
  Alternatives (an OTLP metrics exporter, a background rollup table) add moving
  parts the current single-process shell does not need.
- Aggregate on the pass count and fallback count as sums, and latency as a
  histogram keyed by the provider model already present on the envelope. A
  per-label distribution is rejected: label cardinality is configuration-defined
  and would make the metrics list unreadable.
- Missing fields contribute to nothing rather than to zero, so a partially
  reported event cannot fake a healthy aggregate.

## Risks / Trade-offs

- [Aggregates derived in-process disappear on restart] → the Metrics view
  already treats the current session's data as the working set; durable history
  is out of scope and can be added later behind the same metric names.
- [Counts drift from traces if the two stores ingest at different times] →
  both read the same parsed event stream, and the refresh path is the existing
  one.
