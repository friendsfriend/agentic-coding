## Why

When the `agentic-coding` TUI (home/manager mode) is stopped normally — `q`, double-`q`, or an OS signal — the OTLP server stack it owns is never properly stopped: the HTTP receiver (`Bun.serve`) keeps the process alive with port 4318 still bound, the gRPC sidecar subprocess is orphaned, and the Prometheus scraper / StatsD listener keep running. The user sees the TUI vanish but the server keeps running.

## What Changes

- The TUI shows a **startup modal** in home/manager mode: a progress indicator over the server-stack bootstrap (workspace history load, HTTP receiver, gRPC sidecar, metric collectors) that stays visible until the server is started.
- The TUI shows a **shutdown modal** in home/manager mode: on normal quit (`q`/double-`q`) and on OS signals (SIGINT/SIGTERM/SIGHUP), a progress indicator tracks the server-stack stop and the TUI only exits once the server is stopped.
- The server-stack stop sequence actually stops everything: HTTP receiver servers, gRPC sidecar (with wait-for-exit), Prometheus scraper, StatsD listener, and the trace DB; the process then exits and releases port 4318, leaving no orphaned processes.
- Per-workflow dashboard (`dash`) mode keeps its current quit behavior unchanged (no receiver stack there).

## Capabilities

### New Capabilities
- `tui-server-lifecycle`: Startup and shutdown progress feedback for the OTLP server stack in the `agentic-coding` TUI, plus a guaranteed clean server stop before process exit.

### Modified Capabilities
<!-- None: dash-mode quit behavior and receiver binding (local-otel-trace-viewer) are unchanged. -->

## Impact

- `agentic-coding/src/tui/index.tsx` — render-before-bootstrap reorder, server-stack start/stop functions, signal handlers.
- `agentic-coding/src/tui/dash/Home.tsx`, `agentic-coding/src/tui/otel/app/App.tsx` — quit key handlers route through the shutdown flow in home mode.
- New: server-lifecycle state module + lifecycle modal component (`src/tui/`), rendered at the renderer root via `Portal` (pattern from dashboard-modal-centering).
- New tests: lifecycle unit tests + renderer-level modal test (pattern from `test/dash/modalCentering.test.ts`).
- No new dependencies, no engine/CLI/data changes.
