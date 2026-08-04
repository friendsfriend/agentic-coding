## Context

See proposal.md — Why. Facts verified against the current tree:

- `src/tui/index.tsx` boots the server stack before rendering: sync db scan → gRPC sidecar spawn → HTTP receiver `Bun.serve` (port 4318 default in home/manager) → Prometheus scraper → StatsD listener → topology load. `cleanup()` (sidecar kill, scraper/statsd stop, `db.close()`, `renderer.destroy()`) is registered **only** on SIGINT/SIGTERM/SIGHUP and does not stop the HTTP receiver servers — the `servers` array is block-scoped inside the bootstrap `if`.
- Normal quit never runs `cleanup()` at all: `Home.tsx` (`q`), `dash/App.tsx` and `otel/app/App.tsx` (double `q`/Ctrl+C) call `renderer.destroy()` directly.
- Empirically, `Bun.serve` and `fs.watch` both keep the Bun process alive. So after a normal quit the process lingers with the receiver bound, and the gRPC sidecar (separate subprocess) is orphaned. Dash mode lingers on the DB watchers alone.
- Decision scope (developer-confirmed): modals apply to home/manager mode only; dash mode keeps its current quit behavior. OS signals route through the same shutdown flow. Startup modal requires render-before-bootstrap.

## Goals / Non-Goals

**Goals:**
- One lifecycle state module + one modal component covering startup and shutdown progress.
- A single `requestShutdown()` entry used by all quit paths in home mode (keys + signals), idempotent, that runs the full stop sequence and guarantees process exit.
- Guarantee the stop sequence releases the receiver port and terminates the sidecar even though `Bun.serve`/watchers would otherwise keep the process alive.

**Non-Goals:**
- Changing dash-mode quit behavior (double-press, instant destroy).
- Changing the receiver/sidecar protocol behavior — only their start/stop lifecycle gets managed and surfaced.
- Adding artificial delays to make progress visible; the modal reflects real step completion.
- Engine, CLI, or data-model changes.

## Decisions

**D1: Dedicated lifecycle state module with Solid signals, consumed by a root-level modal.**
`src/tui/lifecycle.ts` holds `phase` (`idle | starting | running | stopping`), ordered step list with per-step status (`pending | active | done | error`), and a message line, as module-level signals. `src/tui/lifecycle/LifecycleModal.tsx` renders a Portal-anchored overlay (the `dashboard-modal-centering` pattern: `<Portal ref={el => el.position = 'absolute'}>`) so it covers the terminal regardless of active tab, and is mounted once next to `OtelApp` in `index.tsx`. index.tsx drives the store; components only read it.
- Alternative A (props drilling through OtelApp): couples the shell's lifecycle to every component boundary. Rejected — the modal is global chrome, not a tab feature.
- Alternative B (local state inside OtelApp): the shell owns the server stack, so state must live outside the component tree. Rejected.

**D2: Render first, then bootstrap asynchronously with step yields.**
Reorder `main()`: create renderer/keymap, render the app with the startup modal visible, then run the bootstrap as an async sequence (`await tick()` between steps so the 30fps renderer paints step transitions). Steps: workspace history load (db scan + span load + topology) → HTTP receivers → gRPC sidecar → Prometheus/StatsD. The modal dismisses when the last step completes. Stores are reactive, so the observability views mount empty and fill once history loads — the modal covers that window.
- Alternative A (keep sync bootstrap): startup modal impossible by construction — nothing is painted yet. Rejected per developer decision.
- Alternative B (chunked async db scan): unnecessary complexity; the sync scan freezes the modal briefly, which still reads as progress. Rejected (ponytail).

**D3: One `requestShutdown()` global (same pattern as the existing `globalThis.__renderer`), idempotent, used by keys and signals.**
`(globalThis as any).__requestShutdown` is registered by the shell. `Home.tsx` `q` and `otel/app/App.tsx` double-`q` (home mode only) call it; dash-mode quit paths stay on `renderer.destroy()`. The SIGINT/SIGTERM/SIGHUP handlers call it too. A `shutdownRequested` flag makes it idempotent; a `starting`-phase quit abandons startup (bootstrap checks the flag between steps and stops what already started).
- Alternative: a custom event bus. Overkill for two call sites — the existing `__renderer` global is precedent. Rejected.

**D4: Stop sequence order and guaranteed exit.**
`stopServerStack()`: stop HTTP receiver servers (`stop(true)` closes active connections) → kill gRPC sidecar and wait for its `exit` event with a 2s timeout → stop Prometheus scraper → stop StatsD listener → `db.close()` → `renderer.destroy()` → small paint tick → `process.exit(0)`. The explicit `process.exit(0)` is required: `Bun.serve` and watchers otherwise keep the process alive after destroy (verified empirically). Sidecar wait is bounded so a hung sidecar never blocks exit.

**D5: Startup failure handling.**
If a bootstrap step fails (e.g. receiver port already in use), mark the step `error`, show the message, hold ~1s so the user sees it, then `process.exit(1)` — replacing the current `console.error` + immediate exit, which would now be invisible behind the modal.

## Risks / Trade-offs

- [Startup modal briefly freezes during the synchronous db scan] → Modal stays visible with the animated progress bar; scan is a single step, no correctness impact.
- [Signal arrives mid-bootstrap] → `shutdownRequested` flag + idempotent `requestShutdown`; stop sequence tolerates partially-started stack (every component optional).
- [Sidecar ignores SIGTERM and hangs] → 2s bounded wait, then proceed; process exit is unconditional.
- [Renderer destroy + immediate `process.exit` could cut the final modal frame] → One paint tick after destroy before exit; cosmetic only, no functional impact.
- [Keys pressed while shutdown modal shows] → Lifecycle phase guard at the top of the home/otel key handlers; `requestShutdown` is idempotent regardless.

## Migration Plan

No migration: TUI-only change, no data or config format changes. Rollback = revert the change. Manual verification path: `bun run dev:ui` (home mode) — quit with `q`, confirm modal + process exit + port 4318 released; `bun run dev:ui-dash` — confirm dash quit behavior unchanged.

## Open Questions

None.
