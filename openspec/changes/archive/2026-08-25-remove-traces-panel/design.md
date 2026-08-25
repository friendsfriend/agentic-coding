## Context

The agent-dash dashboard (`agentic-coding/src/tui/dash/App.tsx`) currently renders a `Traces · <count>` panel in the bottom row next to `Git status` (panel index 5 in the Tab cycle `[0, 6, 1, 2, 4, 5]`). Pressing Enter on it opens an embedded `TraceBrowser` modal (`ui/TraceBrowser.tsx`) fed by `data().traceSpans`, backed by a dedicated keymap layer (`traces`) around a `traceDetail` signal.

Traces are now viewed in a dedicated otel TUI tab (`src/tui/otel/`, `--traces-only` mode), which reads the same normalized `traces.jsonl` through the shared parser/traceStore. The dashboard-embedded browser is redundant.

Verified consumers of `traceSpans`: only `App.tsx` (panel title/body + `TraceBrowser` modal). Nothing else in `src/` or `test/` reads `DashData.traceSpans`.

## Goals / Non-Goals

**Goals:**
- Remove the Traces panel, its Enter handler, the embedded TraceBrowser modal, and the associated keymap layer/state from the dash.
- Keep the remaining panel layout, Tab-cycle order, and all other modals untouched.
- Update specs that describe the removed behavior (`local-otel-trace-viewer`, `dashboard-pane-grid`).

**Non-Goals:**
- No changes to the otel TUI tab, receiver, traceStore, or the workflow engine's telemetry writer (`traces.jsonl` keeps being written).
- No redesign of the remaining dashboard panels; `Git status` simply becomes a full-width single-panel row.
- No changes to workflow-engine internals or other workflows.

## Decisions

1. **Remove the panel and modal entirely, no deprecation shim.**
   The Traces panel has no settings, scripts, or persisted state attached; removal is a pure UI deletion. Alternative (keep panel as passive status display) rejected — the user explicitly does not need it, and a dead-end panel invites accidental Enter presses.

2. **Drop `traceSpans` from `DashData`.**
   The field's only consumers are the removed panel and modal. Removing it from `data.ts` (type, loader line, empty-state fallback) deletes dead parsing work per refresh. Alternative (keep loading for future use) rejected — YAGNI; git history preserves the code if traces ever return to the dash.

3. **Keep `watchRefresh.ts` unchanged except its header comment.**
   It watches directories, not individual files, and still needs to react to `telemetry.jsonl`/`state.json`. Dropping traces from the watch set is not possible at directory granularity, so no behavioral change — only update the stale comment mentioning `traces.jsonl`.

4. **Tab-cycle order: remove index 5, keep relative order.**
   `[0, 6, 1, 2, 4, 5]` becomes `[0, 6, 1, 2, 4]`; the `activePanel() === 5` branches (Enter → trace modal) are deleted. Remaining indices keep their meaning, so no renumbering churn across the file.

5. **Spec deltas, not new capabilities.**
   - `local-otel-trace-viewer`: REMOVE the "Managed workflow dashboard trace browser" requirement (traces live in the standalone viewer/tab).
   - `dashboard-pane-grid`: MODIFY "Dashboard panes align on a uniform grid" to describe the post-removal rows (bottom row is full-width `Git status`); gutter-alignment semantics unchanged for the rows that remain.

## Risks / Trade-offs

- [Stale help text or tests referencing the Traces panel] → Sweep `App.tsx` help sections and `test/dash/*` for trace references during implementation; delete/retarget `test/dash/traceView.test.ts` (its shared-parser coverage already exists conceptually under `test/otel/`).
- [Users muscle-memory Enter on the old panel position] → Enter on the last cycled panel now falls through to the gate/approval handling exactly as before for non-trace panels; no hidden state remains.
- [Losing quick per-change trace prefilter] → The otel TUI supports filtering by change; acceptable trade-off stated by the task owner.

## Migration Plan

Single-repo UI removal, no data migration. Rollback = revert the commit. `traces.jsonl` continues to be written by the engine throughout, so nothing to back up.

## Open Questions

None.
