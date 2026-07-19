# Design: otel-ui-improvements — OpenTUI Trace Tree View

## Overview

An OpenTUI/Solid trace viewer embedded in the pi ecosystem. Reads normalized trace JSONL (the format already produced by Herdr workflow telemetry) and renders a tree-based trace browser using the opentui-starter component library.

## Architecture

```
pi/skills/opentui/viewer/
├── index.tsx              # Entry: createRenderer, keymap setup, mount App
├── app/
│   ├── App.tsx            # Root layout: header + trace view + status bar
│   ├── keymap.ts          # Keymap layer registration
│   ├── navigation.ts      # Focus state: list | tree | detail
│   └── notifications.ts   # Toast/notification helpers
├── model/
│   ├── traceStore.ts      # Trace data model: load, index, filter, sort
│   ├── types.ts           # SpanData, TraceSummary types
│   └── parser.ts          # JSONL parser → SpanData[]
├── views/
│   ├── TraceListView.tsx   # Flat list of service root spans (table style)
│   ├── TraceTreeView.tsx   # Collapsible tree for one selected trace
│   └── SpanDetailView.tsx  # Attributes, resource, scope, status for selected span
└── components/
    ├── TraceRow.tsx        # Single span row in tree: indent, icon, name, duration, status
    ├── AttributeTable.tsx  # Key-value attribute renderer
    └── FilterBar.tsx       # Text input for filtering traces
```

## Data Model

```typescript
interface SpanData {
  traceId: string
  spanId: string
  parentSpanId: string      // empty for root spans
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  status: { code: number; message?: string }
  attributes: { key: string; value: pcommon.Value }[]
  resource: { attributes: { key: string; value: pcommon.Value }[]; droppedAttributesCount: number }
  scope: { name: string; version: string }
  serviceName: string
  kind: number
}

interface TraceSource {
  load(): Promise<void>
  onSpan(handler: (span: SpanData) => void): void
}

class JsonlFileSource implements TraceSource {
  constructor(path: string) {}
  load(): Promise<void> { /* read + tail file */ }
  onSpan(handler: (span: SpanData) => void): void {}
}

// ponytail: RemoteSource implements TraceSource — HTTP/gRPC streaming or
// OTLP receiver. Add when a remote data backend exists. JsonlFileSource
// is the only implementation for now; TraceSource isolates the view layer
// from the data origin.

class TraceStore {
  constructor(source: TraceSource) {}

  // Queries
  getRootSpans(): SpanData[]               // spans with no parent
  getTraceSpans(traceId: string): SpanData[]
  getSpanTree(traceId: string): TreeNode[] // nested tree

  // Filter / sort
  applyFilter(query: string): void
  setSort(field: SortField, desc: boolean): void
}
```

## Component Tree

```
App
├── Header                    # App title, icon
├── MainContent               # Split: trace list | detail
│   ├── TraceListView (left)  # Scrollable list of service root spans
│   │   ├── FilterBar         # Text search input
│   │   └── TraceRow[]        # Sortable columns: service, latency, time, name, error
│   └── DetailPanel (right)   # Selected trace or span info
│       ├── TraceTreeView     # Collapsible tree (when trace selected)
│       │   └── TraceRow[]    # Indented tree rows with expand/collapse
│       └── SpanDetailView    # Selected span attributes (when span selected)
└── StatusBar                 # Keybinds context footer
```

## Layout

Uses `ScrollingPanelLayout` from opentui-starter for the trace list, and a custom tree component for the detail panel. Both panels resize horizontally with a split ratio (default 30:70 list-to-detail).

Tree rendering uses nested `<box>` elements with left padding proportional to depth. Expandable nodes show `▼` or `▶` indicator. Selected node gets highlight via `<Selectable>` component.

## Keymap Layers

| Layer | Activation | Key | Action |
|-------|-----------|-----|--------|
| `trace-list` | focus=list | `j`/`k` | Navigate list rows |
| `trace-list` | focus=list | `/` | Focus filter bar |
| `trace-list` | focus=list | `Enter` | Select trace → show tree |
| `trace-list` | focus=list | `Ctrl+s` | Toggle sort (latency) |
| `trace-tree` | focus=tree | `j`/`k` | Navigate tree rows |
| `trace-tree` | focus=tree | `h` | Collapse node |
| `trace-tree` | focus=tree | `l` | Expand node |
| `trace-tree` | focus=tree | `Enter` | Select span → show detail |
| `trace-tree` | focus=tree | `g`/`G` | First/last node |
| `tree-detail` | focus=detail | `d` | Switch focus to detail |
| `tree-detail` | focus=detail | `t` | Switch focus to tree/list |
| `global` | always | `?` | Help modal |
| `global` | always | `q` | Quit |

## Resize & Persistence

- Left/right split uses resize handles (same pattern as otel-tui Go implementation's `layout.ResizeManager`).
- Layout ratios persist in session but reset on restart.

## Trace JSONL Format

Expected format (matching Herdr workflow telemetry output):

```jsonl
{"traceId":"...","spanId":"...","parentSpanId":"...","name":"GET /api/...","startTimeUnixNano":"...","endTimeUnixNano":"...","status":{"code":0},"attributes":[...],"resource":{"attributes":[...]},"scope":{"name":"...","version":"..."}}
```

## Future: Remote data source

The `TraceSource` interface lets a remote source (OTLP HTTP/gRPC receiver, WebSocket stream, REST API) replace or complement `JsonlFileSource` without touching any view code. When a remote backend materialises:

1. Write `OtlpHttpSource implements TraceSource` that binds a local OTLP receiver
2. Wire it into `TraceStore` constructor (or compose both sources)
3. The tree view, list view, and detail view work unchanged

No code outside `model/` needs to change.

## Non-goals

- OTLP network receiver in the OpenTUI viewer — the Go `otel-tui` binary handles that for now.
- Metric or log views — scope is trace tree only.
- Edit/export of traces — read-only browsing.
- Integration with agent-dash panels — standalone viewer first.
