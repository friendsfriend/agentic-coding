## Multi-Protocol Gateway

- [x] **T1.1** Add `MetricData`, `LogData`, `ServiceNode` types to `model/types.ts`
- [x] **T1.2** Add metrics and logs tables to `model/db.ts` alongside existing traces table
- [x] **T1.3** Implement `metricStore.ts`: metric stream indexing, filter, sort, aggregation
- [x] **T1.4** Implement `logStore.ts`: log record indexing, filter, trace-id lookup
- [x] **T1.5** Implement `topologyStore.ts`: service graph builder from spans + resource attributes
- [x] **T1.6** Write OTLP gRPC sidecar (Node.js with `@grpc/grpc-js`, decoding protobuf → loopback HTTP JSON)
- [x] **T1.7** Write Zipkin HTTP receiver in `receiver/zipkin.ts` (POST `/api/v2/spans`)
- [x] **T1.8** Write Datadog receiver in `receiver/datadog.ts` (traces: multi-version endpoints, metrics: series endpoints, logs: v2 endpoint)
- [x] **T1.9** Write Prometheus scrape receiver in `receiver/prometheus.ts` (text exposition format parser, timer-based scrape)
- [x] **T1.10** Write StatsD UDP receiver in `receiver/statsd.ts` (datagram listener, line protocol parser)
- [x] **T1.11** Wire all receivers into `otel-tui.tsx` entry: CLI flags for each protocol, normaliser dispatch to typed stores
- [x] **T1.12** Add tests for each receiver's normalisation: `receiver/__tests__/otlp-grpc.test.ts`, `receiver/__tests__/zipkin.test.ts`, `receiver/__tests__/datadog.test.ts`, `receiver/__tests__/prometheus.test.ts`, `receiver/__tests__/statsd.test.ts`
- [x] **T1.13** Validate protocol-level edge cases: oversized payloads, missing content-type, partial success responses, concurrent signal batches

## Metrics Viewer

- [x] **T2.1** Implement `MetricsView.tsx`: metric stream list with name, type, service, unit columns
- [x] **T2.2** Implement `Sparkline.tsx` component: Unicode block sparkline for gauge/sum trend
- [x] **T2.3** Implement metric detail view: histogram bar chart, data point table, attribute filter
- [x] **T2.4** Wire metrics tab into `App.tsx` shell with `2` key shortcut
- [x] **T2.5** Add metric-scoped status bar keybinds (j/k list nav, Enter select, Esc back)
- [x] **T2.6** Throttle metric view refresh to 500ms batch interval
- [x] **T2.7** Write metric store tests: aggregation, filter, sort, empty state
- [x] **T2.8** Write Sparkline component tests: zero data, single point, upward/downward trend

## Logs Viewer

- [x] **T3.1** Implement `LogsView.tsx`: log record list with severity, timestamp, service, body columns
- [x] **T3.2** Implement log detail view: full body, attributes, trace/span link (navigates to Traces tab + selects linked trace)
- [x] **T3.3** Implement log filter: text search over body/attributes, severity filter, time range
- [x] **T3.4** Wire logs tab into `App.tsx` shell with `3` key shortcut
- [x] **T3.5** Add log-scoped status bar keybinds
- [x] **T3.6** Write log store tests: filter, trace-id lookup, empty state
- [x] **T3.7** Write log detail view test: trace link navigation activates Traces tab

## Topology Viewer

- [x] **T4.1** Implement `TopologyView.tsx`: full-screen directed graph
- [x] **T4.2** Implement `TopologyGraph.tsx` component: node boxes with box-drawing edges, layered layout
- [x] **T4.3** Handle edge cases: single service, no dependencies, cycle detection
- [x] **T4.4** Degrade to adjacency list view when service count exceeds 50
- [x] **T4.5** Wire topology tab into `App.tsx` shell with `4` key shortcut
- [x] **T4.6** Add topology-scoped status bar keybinds (j/k/h/l pan, / search, Enter focus service)
- [x] **T4.7** Write topology store tests: graph builder, cycle detection, empty state
- [x] **T4.8** Write topology layout tests: layered assignment, crossing minimisation

## Gap Catalog

- [x] **T5.1** Write initial gap catalog document at `openspec/changes/otel-gap-analysis/specs/opentui-gap-catalog/spec.md` with all 8 domains (done in spec scenario)
- [x] **T5.2** Add P0/P1/P2 priority tiers and S-XL effort estimates to each entry
- [x] **T5.3** Write recipe cards for each P0 candidate with span names, parent strategy, attributes, file paths, sample code
- [x] **T5.4** Add instrumentation-completed markers with change ID references as domains are covered
- [x] **T5.5** Review and update gap catalog quarterly

## Tab Shell & Navigation

- [x] **T6.1** Refactor `App.tsx` to tab shell: state for active tab, conditional view rendering
- [x] **T6.2** Add tab bar component: `[1] Traces [2] Metrics [3] Logs [4] Topology`
- [x] **T6.3** Add global keybinds: `1`/`2`/`3`/`4` for tab switch, `q` for quit across all tabs
- [x] **T6.4** Ensure trace-only mode is preserved: run `--traces-only` flag hides non-traces tabs
- [x] **T6.5** Write tab shell tests: tab switch, keybind correctness, backward compatibility
