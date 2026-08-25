## 1. Dashboard UI removal (`src/tui/dash/`)

- [x] 1.1 In `App.tsx`: delete the `Traces · …` Panel JSX from the bottom row and let `Git status` span the full row width
- [x] 1.2 In `App.tsx`: remove the `activePanel() === 5` Enter branch that opened the trace modal
- [x] 1.3 In `App.tsx`: change the Tab-cycle order from `[0, 6, 1, 2, 4, 5]` to `[0, 6, 1, 2, 4]`
- [x] 1.4 In `App.tsx`: remove `traceDetail` signal, the `traces` keymap layer (`registerLayer` + its disposer call), the `<Show when={traceDetail()}>` modal block, and the now-unused `TraceBrowser` import
- [x] 1.5 In `data.ts`: remove `traceSpans` from `DashData`, its loader line parsing `traces.jsonl`, and the empty-state fallback; update the stale `traces.jsonl` mention in `watchRefresh.ts` header comment

## 2. Tests

- [x] 2.1 Remove `test/dash/traceView.test.ts` (shared parser/store coverage remains under `test/otel/`)
- [x] 2.2 Sweep remaining `test/dash/*` for Traces-panel references (panel indices, keybindings) and update or extend to assert the removed panel no longer renders / Tab cycle skips it

## 3. Validation

- [x] 3.1 Run dash test suite (`bun test test/dash`) — green
- [x] 3.2 Run type check and lint per repo standards (`bun run type-check`, `bun run lint` in `agentic-coding/`)
- [x] 3.3 Manual smoke: launch agent-dash on a workflow, confirm bottom row is full-width Git status, Tab cycle excludes traces, Enter on remaining panels behaves as before, and the otel TUI tab still loads `traces.jsonl`
