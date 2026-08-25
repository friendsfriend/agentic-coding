## Why

The agent-dash TUI still embeds its own Traces panel and trace-browser modal even though traces are now viewed in a dedicated otel TUI tab. The embedded panel is redundant surface area: it duplicates trace rendering, adds a panel index/keybinding/modal layer to an already dense dashboard, and must be kept in sync with the workflow engine's `traces.jsonl` format for little value.

## What Changes

- Remove the `Traces · <span count>` panel from the dashboard detail view; the bottom row becomes a single full-width `Git status` panel.
- Remove the Enter-on-panel handler that opened the embedded `TraceBrowser` modal and the associated `traces` keymap layer / `traceDetail` signal.
- Remove the `TraceBrowser` import from the dash app if no longer referenced.
- Adjust the Tab-cycle panel order (`[0, 6, 1, 2, 4, 5]`) so the removed panel index disappears without changing the relative order of the remaining panels.
- Keep `traceSpans` loading in `data.ts` only if still consumed elsewhere (e.g. watch refresh); otherwise drop it from the dash data model.
- Trace inspection continues to work unchanged via the dedicated otel TUI tab (`--traces-only` mode reads the same normalized `traces.jsonl`). No replacement capability is introduced.

## Capabilities

### New Capabilities

<!-- none: this change only removes redundant UI; trace viewing already exists in the otel TUI -->

### Modified Capabilities

- `local-otel-trace-viewer`: Removes the "Managed workflow dashboard trace browser" requirement — the Herdr dashboard SHALL NO LONGER embed a trace browser/Traces panel; developers inspect workflow traces in the standalone otel TUI instead. The bounded-ingestion and viewer requirements are unaffected.
- `dashboard-pane-grid`: Updates the grid scenario that references the bottom `Git status`/`Traces` two-column row — after removal, the bottom row is the full-width `Git status` panel, so gutter-alignment behavior is reworded around the rows that actually remain.

## Impact

- **Code** (`agentic-coding/src/tui/dash/`): `App.tsx` (panel JSX, `activePanel === 5` handlers, Tab-cycle order, `traces` keymap layer, `traceDetail` state, help text if it mentions traces), `data.ts` (`traceSpans` field and `traces.jsonl` parsing — pending check for other consumers).
- **Tests**: `test/dash/traceView.test.ts` (covers data.ts + TraceBrowser reading engine-written `traces.jsonl`) needs removal or retargeting; other dash tests may reference panel indices.
- **Specs**: deltas for `local-otel-trace-viewer` and `dashboard-pane-grid`.
- **No impact** on the workflow engine's telemetry writer, `watchRefresh.ts` change detection (still watches `traces.jsonl` for refresh triggering), or the otel receiver/TUI itself.
