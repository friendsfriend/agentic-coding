## Why

The existing `local-otel-trace-viewer` spec defines a standalone Go binary for trace viewing. However, the Herdr dashboard (`agent-dash`) needs a TypeScript/OpenTUI trace browser that can be embedded directly into the pi/agent-dash ecosystem, using the same JSONL trace files already produced by Herdr workflow telemetry. The Go binary requires a separate build chain and does not share components with the dashboard UI. A TypeScript implementation using OpenTUI and the opentui-starter baseline gives us:

- Shared component library between dashboard and trace viewer
- Same theme system, keymap layers, and navigation patterns
- Direct access to workflow trace JSONL files without network receiver
- Single build system for the `agent-dash` package

## What Changes

- **New `otel-tui` app in opentui-starter style** under `pi/skills/opentui/viewer/` (or equivalent path in the pi repo), built as a Solid/OpenTUI application using the opentui-starter baseline.
- **Tree-based trace browser** that reads normalized trace JSONL and renders spans in a collapsible parent/child tree — matching the otel-tui (Go) interaction model but using opentui components.
- **Trace list panel** showing service root spans with service name, latency, received time, and error indicator — filterable by text search, sortable by latency.
- **Span detail panel** showing selected span's attributes, resource, scope, status, and timing — triggered by tree node selection.
- **Live trace update** when the JSONL file is appended to (tail mode), with new spans appearing in the tree without restart.

## Capabilities

### New Capabilities
- `opentui-trace-tree`: Collapsible tree view of trace spans with parent/child indentation, expand/collapse, and focus selection.
- `opentui-trace-list`: Flat list of service root spans with sort/filter, similar to otel-tui trace table.
- `opentui-span-detail`: Attribute viewer for selected span showing resource, scope, status, and tags.
- `opentui-jsonl-tail`: Live trace ingestion by tailing a JSONL file (using `fs.watch` or polling).
- `opentui-trace-source`: Interface-based data layer (`TraceSource`) decouples view from data origin — file, OTLP receiver, or future remote API all plug in without view changes.
- `opentui-trace-keybinds`: Keyboard navigation for tree (j/k, h/l collapse/expand, Enter select, / filter).

### Modified Capabilities
- `local-otel-trace-viewer`: The existing standalone Go spec remains valid for the network receiver use case. The OpenTUI viewer adds a second implementation path optimized for local JSONL browsing.

## Impact

- New source files under `pi/skills/opentui/viewer/` — no changes to existing pi core.
- Depends on `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, `solid-js` (already in opentui-starter baseline).
- Requires the trace JSONL format already produced by Herdr workflow telemetry (no new protocol dependencies).
- No changes to the Go `otel-tui` binary — it remains as-is for network receiver use cases.
- `TraceSource` interface is the only abstraction layer — added now as a seam so remote data sources require zero view changes later.
