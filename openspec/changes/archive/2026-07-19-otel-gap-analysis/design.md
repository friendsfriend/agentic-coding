## Context

The OpenTUI trace viewer (`pi/skills/opentui/viewer/`) and agent-dash `otel-tui.tsx` entry point handle one signal type (traces) over one protocol (OTLP HTTP JSON). The Go `otel-tui` binary (`~/otel-tui`) handles six protocols and three signal types (traces, metrics, logs) plus a topology view. Users want the OpenTUI viewer to match the Go binary's signal breadth and protocol support, plus document which actions in the Pi/Herdr ecosystem remain untraced.

## Goals / Non-Goals

**Goals:**

- Document every untraced action domain in Pi core, agent-dash, git, notifications, error recovery, OpenSpec, and workflow admin, prioritised by observability value.
- Render metrics (gauge, sum, histogram streams) in the terminal viewer alongside traces.
- Render logs (list, filter, detail, trace correlation) in the terminal viewer alongside traces.
- Render a topology graph (service dependency diagram) in the terminal viewer.
- Accept traces, metrics, and logs via OTLP gRPC, Zipkin HTTP, Datadog HTTP, Prometheus scrape, and StatsD UDP in addition to existing OTLP HTTP JSON.
- Share one navigation shell with tab switching between Traces, Metrics, Logs, and Topology.
- Keep all existing trace-only functionality working with zero regression.

**Non-Goals:**

- Distributed querying or cross-signal correlation engine — each signal type has its own store and views.
- Metrics alerting or threshold evaluation — display only.
- Logs search index or long-term retention — bounded in-memory buffer like traces.
- Full Prometheus query language (PromQL) — scrape and display only.
- Authentication for multi-protocol receivers — same security model as existing HTTP receiver (loopback default, documented no-auth).

## Architecture

```
viewer/
├── index.tsx              # CLI entry: --trace/--metric/--log sources, tab
├── app/
│   ├── App.tsx            # Tab shell: Traces | Metrics | Logs | Topology
│   ├── keymap.ts          # Global + signal-scoped keymap layers
│   ├── navigation.ts      # Focus: tab | list | detail | modal
│   └── notifications.ts   # Shared toast system
├── model/
│   ├── types.ts           # SpanData, MetricData, LogData, ServiceNode
│   ├── traceStore.ts      # Existing — unchanged
│   ├── metricStore.ts     # Metric stream indexing, filter, aggregation
│   ├── logStore.ts        # Log record indexing, filter, trace-id lookup
│   ├── topologyStore.ts   # Service graph builder from spans + resource attrs
│   ├── parser.ts          # Existing JSONL parser — unchanged
│   └── db.ts              # Extended with metrics/logs tables
├── views/
│   ├── TraceListView.tsx  # Existing — unchanged
│   ├── TraceTreeView.tsx  # Existing — unchanged
│   ├── SpanDetailView.tsx # Existing — unchanged
│   ├── MetricsView.tsx    # Metric stream list + gauge/sum/histogram chart
│   ├── LogsView.tsx       # Log record list + detail + trace drill-down
│   └── TopologyView.tsx   # Service node-edge graph
├── components/
│   ├── Badge.tsx          # Existing — unchanged
│   ├── FilterStatusBar.tsx# Existing — unchanged
│   ├── GenericModal.tsx   # Existing — unchanged
│   ├── Highlight.tsx      # Existing — unchanged
│   ├── Notification.tsx   # Existing — unchanged
│   ├── ScrollableContent.tsx# Existing — unchanged
│   ├── SearchHeader.tsx   # Existing — unchanged
│   ├── Selectable.tsx     # Existing — unchanged
│   ├── StatusBar.tsx      # Existing — unchanged
│   ├── TraceModals.tsx    # Existing — unchanged
│   ├── Sparkline.tsx      # Unicode-block sparkline for metric streams
│   └── TopologyGraph.tsx  # Directed graph renderer with box/canvas
└── receiver/
    ├── otlp.ts            # OTLP HTTP JSON + gRPC (existing+new)
    ├── zipkin.ts          # Zipkin HTTP span receiver
    ├── datadog.ts         # Datadog traces+metrics+logs HTTP receiver
    ├── prometheus.ts      # Prometheus scrape + metric parser
    └── statsd.ts          # StatsD UDP metric receiver
```

## Multi-Protocol Gateway

```
                        ┌──────────────────┐
  OTLP HTTP :4318 ─────▶│                  │
  OTLP gRPC :4317 ─────▶│  Normaliser /    │──▶ TraceStore
  Zipkin    :9411 ─────▶│  Signal Router   │──▶ MetricStore
  Datadog   :8126 ─────▶│                  │──▶ LogStore
  StatsD    :8125 ─────▶│                  │
  Prom scrape ──────────▶│                  │
                        └──────────────────┘
```

Each receiver normalises inbound data into internal typed models (`SpanData`, `MetricData`, `LogData`) and pushes into the corresponding store. Stores are signal-scoped but share the SQLite DB for persistence. The existing OTLP HTTP JSON path continues unchanged — the normaliser adds new protocol parsers alongside it.

## Signal Models

```typescript
interface MetricData {
  resource: { attributes: Array<{ key: string; value: string }> };
  scope: { name: string; version: string };
  name: string;
  description: string;
  unit: string;
  type: 'gauge' | 'sum' | 'histogram';
  dataPoints: MetricDataPoint[];
  serviceName: string;
}

interface MetricDataPoint {
  startTimeUnixNano: string;
  timeUnixNano: string;
  value: number;                          // gauge/sum single value
  bucketCounts?: number[];                // histogram
  explicitBounds?: number[];              // histogram
  attributes: Array<{ key: string; value: string }>;
}

interface LogData {
  resource: { attributes: Array<{ key: string; value: string }> };
  scope: { name: string; version: string };
  timeUnixNano: string;
  severity: string;                       // TRACE, DEBUG, INFO, WARN, ERROR, FATAL
  body: string;
  attributes: Array<{ key: string; value: string }>;
  traceId?: string;                       // for trace correlation
  spanId?: string;
  serviceName: string;
}

interface ServiceNode {
  id: string;                             // service name
  parentIds: string[];                    // upstream services
  childIds: string[];                     // downstream services
  spanCount: number;
  errorCount: number;
  avgDurationMs: number;
}
```

## Component Tree

```
App (tab shell)
├── TabBar: Traces | Metrics | Logs | Topology
├── TabContent (signal-scoped)
│   ├── TracesTab
│   │   ├── TraceListView (left panel)
│   │   └── DetailPanel (right)
│   │       ├── TraceTreeView
│   │       └── SpanDetailView
│   ├── MetricsTab
│   │   ├── MetricListView (left)
│   │   └── MetricDetailView (right)
│   │       └── Sparkline chart
│   ├── LogsTab
│   │   ├── LogListView (left)
│   │   └── LogDetailView (right)
│   └── TopologyTab
│       └── TopologyGraph (full screen, scrollable)
└── StatusBar (context-sensitive keybinds)
```

## Metric Chart Rendering

Use Unicode block characters (`▁▂▃▄▅▆▇█`) for sparkline charts. Gauge/sum render as a horizontal trend line over the last N data points. Histogram renders as a vertical bar chart of bucket boundaries vs count, with the bar as coloured blocks. Both fit within a fixed-height terminal box and scroll horizontally for longer windows.

## Topology Graph Rendering

Service nodes rendered as labelled boxes with directed edges using box-drawing characters (`─│┌┐└┘├┤┬┴┼`). Layout uses a simple layered (Sugiyama-style) pass: group services by trace-inferred dependency layer, then assign horizontal slots with minimised crossing. For <20 nodes this runs fast enough for interactive use; above that the graph degrades to an adjacency list view with a note.

## Tab Navigation

| Key | Global | Traces | Metrics | Logs | Topology |
|-----|--------|--------|---------|------|----------|
| `1` | → Traces tab | — | — | — | — |
| `2` | → Metrics tab | — | — | — | — |
| `3` | → Logs tab | — | — | — | — |
| `4` | → Topology tab | — | — | — | — |
| `j/k` | — | List nav | List nav | List nav | Pan vertical |
| `h/l` | — | Collapse/expand | — | — | Pan horizontal |
| `Enter` | — | Select trace | Select metric | Select log | — |
| `/` | — | Search | Search | Search | Search |
| `q` | Quit | Quit | Quit | Quit | Quit |

## Data Flow

```
Receiver (HTTP/gRPC/etc)
  │
  ▼
Normaliser → typed signal model
  │
  ▼
Store (TraceStore | MetricStore | LogStore | TopologyStore)
  │
  ├── SQLite persistence (db.ts)
  │
  ▼
View component (reads store signals, renders tab content)
  │
  ▼
Tab shell (App.tsx switches visible view component)
```

## Risks / Trade-offs

- **gRPC in Bun**: Bun lacks native gRPC server. Options: (a) embed gRPC via FFI to a C gRPC library, (b) spawn a sidecar Node.js process with `@grpc/grpc-js`, (c) document that gRPC requires an external OTLP collector. Recommend (b) as pragmatic: the sidecar converts gRPC to HTTP JSON on loopback. Trace-only users skip it.
- **Prometheus scrape**: Requires target endpoints to be reachable from viewer process. Document that scrape works best when viewer runs on same host as targets.
- **StatsD UDP**: Best-effort datagram reception; drops under extreme load are expected.
- **Chart performance**: Re-rendering sparkline on every data point causes flicker. Mitigation: throttle metric view refresh to 500ms and batch incoming data points.
- **Topology scale**: Dependency graph layout is O(N²) in node count. Degrade gracefully to adjacency list above 50 services.
