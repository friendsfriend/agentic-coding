- [x] **T1: Scaffold project from opentui-starter baseline**
  - Copy opentui-starter structure into `pi/skills/opentui/viewer/`
  - Adapt `package.json`, `tsconfig.json`, build scripts for the viewer target
  - Verify `bun run dev` launches empty viewer shell

- [x] **T2: Implement trace data model**
  - `model/types.ts` — SpanData, TreeNode, TraceSummary interfaces
  - `model/parser.ts` — JSONL parser that validates and normalises span lines
  - `model/traceStore.ts` — TraceStore class with loadFile, appendLine, getRootSpans, getTraceSpans, getSpanTree, applyFilter, setSort
  - Unit test with sample trace data (use test_data.json from otel-tui)

- [x] **T3: Build TraceListView**
  - `views/TraceListView.tsx` — Flat scrollable list of service root spans
  - Columns: error indicator, service name, latency, received time, span name
  - `components/FilterBar.tsx` — Text input with clear, triggers `store.applyFilter()`
  - Sort by latency (Ctrl+s to toggle), show sort indicator in header
  - Use `<Selectable>` for row selection, `<HighlightedText>` for search matches

- [x] **T4: Build TraceTreeView**
  - `views/TraceTreeView.tsx` — Collapsible tree for one trace's spans
  - `components/TraceRow.tsx` — Single span row: depth indent, expand/collapse chevron, name, duration, status color
  - Build tree structure from `store.getSpanTree(traceId)` — nest children under parents
  - Keyboard: `h` collapse, `l` expand, `Enter` select, `j`/`k` navigate, `g`/`G` first/last
  - Click/mouse expand via `onMouseUp` on node indicator

- [x] **T5: Build SpanDetailView**
  - `views/SpanDetailView.tsx` — Shows selected span's attributes, resource, scope, status, timing
  - `components/AttributeTable.tsx` — Key-value table renderer (keys sorted, values truncated to terminal width)
  - Show span kind, start/end timestamps, duration, status code and message

- [x] **T6: Wire up keymaps and navigation**
  - `app/keymap.ts` — Register layers: `trace-list`, `trace-tree`, `tree-detail`, `global`
  - Layer conditions: focus state (`list`, `tree`, `detail`), no modal active
  - Split focus with `d` (detail) / `t` (tree/list) toggle
  - `?` opens help modal with keybind reference
  - Modal layers for help, splash

- [x] **T7: Implement JSONL tailing**
  - Polling or `fs.watch` on the input JSONL file
  - New lines appended → `store.appendLine()` → view auto-updates
  - Debounce to avoid re-render thrashing (100ms interval)

- [x] **T8: Integration smoke test**
  - Launch viewer with sample trace JSONL file (from `test_data.json`)
  - Verify list shows root spans, selecting a trace shows tree, expanding tree nodes works
  - Verify Enter on span node shows detail panel with attributes
  - Verify filter bar filters root spans by name/service
  - Verify JSONL tailing: append a line to file, see it appear
