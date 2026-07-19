## Why

Current OpenTUI trace viewer (`pi/skills/opentui/viewer/`) reads Herdr workflow telemetry JSONL via SQLite and renders a trace list, span tree, and span detail view. Agent-dash includes an embedded `TraceBrowser` component and a standalone `otel-tui` receiver entry point. Two earlier changes built this:

1. **ui-improvements-and-telemetry** — added `herdr-agent-telemetry` (correlated OTLP traces for agent/workflow actions) and `local-otel-trace-viewer` (standalone OTLP receiver + dashboard integration).
2. **otel-ui-improvements** — added the OpenTUI tree-based trace browser with `TraceStore`, `TraceDb`, workspace scanning, filtering, and sorting.

Despite these foundations, three gaps remain:

- **Coverage gap**: Pi runtime, dashboard UI, git/notification/error-recovery operations, OpenSpec, and workflow admin actions emit no traces. Only agent-message, model-turn, and tool-execution paths are instrumented.
- **Signal gap**: The viewer handles traces only. The Go `otel-tui` binary (at `~/otel-tui`) also handles metrics, logs, and topology — users want those views in the OpenTUI viewer.
- **Protocol gap**: Only OTLP/HTTP JSON inbound is supported. The Go binary accepts OTLP gRPC, Zipkin, Datadog, Prometheus, and StatsD. Users want full multi-protocol ingestion so any OpenTelemetry-emitting application can feed the viewer.

## What Changes

- **System-wide gap analysis document** cataloging every untraced action domain, prioritised by observability value, with recommended instrumentation points and effort estimates.
- **Metrics viewer** — gauge, sum, histogram chart views for ingested metric streams, matching Go binary's metric page capabilities.
- **Logs viewer** — log list, filter, detail, and trace/span correlation, matching Go binary's log page.
- **Topology viewer** — service dependency graph built from trace parent/child and resource attributes, matching Go binary's topology page.
- **Multi-protocol gateway** — OTLP gRPC, Zipkin, Datadog (traces+metrics+logs), Prometheus, and StatsD receivers alongside existing OTLP HTTP JSON receiver.
- **Typed signal model** — `MetricData`, `LogData` types and stores alongside `SpanData`, sharing `TraceDb` persistence and `TraceSource` interface.
- **Signal-scoped navigation** — top-level tab bar switching between Traces, Metrics, Logs, Topology views, each with its own list/detail/filter keymap layer.

## Capabilities

### New Capabilities

- `opentui-metrics-viewer`: Metric stream table with gauge/sum/histogram sparkline chart, filtering, and detail panel.
- `opentui-logs-viewer`: Log record list with text/attribute filter, timestamp sorting, and linked trace/span drill-down.
- `opentui-topology-viewer`: Service dependency graph rendered as directed node-edge diagram using OpenTUI box/canvas components.
- `opentui-multi-protocol-gateway`: OTLP gRPC, Zipkin HTTP, Datadog HTTP, Prometheus scrape, and StatsD UDP receivers, all normalising into internal typed signal model.
- `opentui-gap-catalog`: Living document of untraced action domains with instrumentation recipe cards.

### Modified Capabilities

- `opentui-trace-tree`: Unchanged — trace tree remains as-is under Traces tab.
- `opentui-trace-list`: Unchanged — moves under Traces tab alongside tree and detail.
- `opentui-span-detail`: Unchanged — moves under Traces tab.
- `opentui-trace-source`: Extended with `supportsSignal(signal)` query method so receivers advertise which signal types they provide.
- `local-otel-trace-viewer`: Standalone receiver gains gRPC+Zipkin+Datadog+Prometheus+StatsD listeners; top-level tab bar chooses which signal to browse. Backward-compatible: `--http` flag still works, new flags for new protocols.
- `herdr-agent-telemetry`: Unchanged — gap catalog documents future instrumentation, no wire changes now.

## Impact

| Area | Files | Change |
|------|-------|--------|
| Gap catalog | `openspec/changes/otel-gap-analysis/specs/opentui-gap-catalog/spec.md` | New living document |
| Signal model | `pi/skills/opentui/viewer/model/types.ts`, `model/metrics.ts`, `model/logs.ts` | Add MetricData, LogData, typed stores |
| Persistence | `model/db.ts` | Add metrics/logs tables, signal-scoped queries |
| Receiver | `agent-dash/src/receiver.ts`, `agent-dash/src/otel-tui.tsx` | gRPC/HTTP multi-protocol dispatch, Zipkin/Datadog/Prometheus/StatsD parsers |
| Views | `views/MetricsView.tsx`, `views/LogsView.tsx`, `views/TopologyView.tsx` | New view files |
| Navigation | `app/App.tsx`, `app/navigation.ts` | Tab bar, signal-scoped keymap layers |
| Components | `components/Sparkline.tsx`, `components/TopologyGraph.tsx` | Chart and graph primitives |
| Tests | `model/metrics.test.ts`, `model/logs.test.ts`, `model/topology.test.ts` | New test files |
| Build | `package.json` | No new dependencies |

## Migration Plan

1. Write gap catalog document (spec scenario, one-shot, informs future work).
2. Add `MetricData`/`LogData` types, stores, and DB tables alongside existing span model.
3. Add multi-protocol receiver parsers (gRPC, Zipkin, Datadog, Prometheus, StatsD).
4. Wire receiver dispatch to typed stores; existing OTLP HTTP JSON path unchanged.
5. Build Metrics, Logs, Topology views as tab-scoped Solid components.
6. Add tab navigation and signal-scoped keymap layers.
7. Document new CLI flags and signal selection.
8. Rollback by removing new view/receiver/parsers; trace-only mode works as before.

## Risks / Trade-offs

- **gRPC dependency**: Requires Bun's `Bun.serve` upgrade path or external process gateway. Mitigation: gRPC receiver runs as optional child process; HTTP-only mode works without it.
- **Chart rendering complexity**: Histogram and topology graphs need canvas-style rendering in terminal. Mitigation: use Unicode block characters and OpenTUI box primitives; fall back to tabular sparkline for terminals without wide glyphs.
- **Datadog protocol variance**: Datadog agent protocol has multiple versions. Mitigation: support stable traces+v3 endpoints; document known version compat.
- **Prometheus scrape coupling**: Receiver needs target endpoints to be reachable. Mitigation: scrape runs on timer; unreachable targets logged but don't block other receivers.
