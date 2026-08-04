## 1. Server lifecycle state module

- [x] 1.1 Create `agentic-coding/src/tui/lifecycle.ts`: Solid-signal store with `phase` (`idle | starting | running | stopping`), ordered step list (`id`, `label`, `status: pending | active | done | error`), and message line; helpers `beginStartup(steps)`, `setStepActive(id)`, `setStepDone(id)`, `setStepError(id, message)`, `finishStartup()`, `beginShutdown(steps)`, `setMessage()`, and a `shutdownRequested` flag with `requestShutdown()` (idempotent, runs the stop sequence then destroys renderer and exits).

## 2. Lifecycle modal component

- [x] 2.1 Create `agentic-coding/src/tui/lifecycle/LifecycleModal.tsx`: Portal-anchored full-terminal overlay (pattern: `<Portal ref={el => el.position = 'absolute'}>` from `dash/ui/GenericModal.tsx`) with a centered dialog showing the lifecycle phase as title ("Starting server…" / "Stopping server…"), the step list with status glyphs (pending/active/done/error), an animated progress bar, and the message line. Renders nothing when phase is `idle`/`running`.
- [x] 2.2 Mount `<LifecycleModal />` once next to `<OtelApp />` in `agentic-coding/src/tui/index.tsx` (sibling inside the root render, modal portals to the renderer root).

## 3. Startup flow (render-first reorder)

- [x] 3.1 In `agentic-coding/src/tui/index.tsx`, move the server-stack bootstrap (db scan + span/topology load, HTTP receiver servers, gRPC sidecar spawn, Prometheus scraper, StatsD listener) out of the pre-render block into an async `startServerStack()` that drives the lifecycle store: `beginStartup(steps)` → per-step `setStepActive`/`setStepDone` with `await tick()` (paint opportunity) between steps → `finishStartup()`. Keep the existing `servers`/`grpcSidecar`/`stopPrometheus`/`stopStatsD` references in a stack object the stop sequence can reach.
- [x] 3.2 Reorder `main()`: create renderer/keymap, `await render(...)` (first paint shows the startup modal), then run `startServerStack()`. Home/manager mode passes startup steps; dash/test modes pass none (no modal).
- [x] 3.3 Startup failure: on a bootstrap error, `setStepError` + message, hold ~1s so the modal shows it, then `process.exit(1)`.

## 4. Shutdown flow

- [x] 4.1 Implement `stopServerStack()` (used by `requestShutdown`): stop HTTP receiver servers (`stop(true)`), kill gRPC sidecar and wait for its `exit` event (2s timeout), stop Prometheus scraper, stop StatsD listener, `db.close()`, `renderer.destroy()`, one paint tick, `process.exit(0)`. Every component optional (partial stack during startup-quit).
- [x] 4.2 Register `(globalThis as any).__requestShutdown` in `index.tsx`; rewire SIGINT/SIGTERM/SIGHUP handlers to call it (replacing the direct `cleanup()`), and keep the dash-mode cleanup path intact for non-home modes.

## 5. Quit key handlers

- [x] 5.1 In `agentic-coding/src/tui/dash/Home.tsx`, replace `renderer.destroy()` on `q` with `__requestShutdown()` and add a lifecycle-phase guard so keys are ignored while the shutdown modal shows.
- [x] 5.2 In `agentic-coding/src/tui/otel/app/App.tsx`, route the double-`q` quit through `__requestShutdown()` when `props.dashboard.mode === 'home'`, keep `renderer.destroy()` for dash mode, and add the same lifecycle-phase guard.
- [x] 5.3 Leave `agentic-coding/src/tui/dash/App.tsx` (per-workflow dashboard) quit behavior unchanged.

## 6. Tests

- [x] 6.1 Unit test `agentic-coding/test/lifecycle.test.ts`: step status transitions, idempotent `requestShutdown`, and that the stop sequence tolerates a partially-started stack (no sidecar, no servers).
- [x] 6.2 Renderer-level test for the lifecycle modal (pattern: `agentic-coding/test/dash/modalCentering.test.ts`): startup modal renders at the renderer root with steps visible; modal absent when phase is `idle`/`running`.

## 7. Verification

- [x] 7.1 Run `bun test` in `agentic-coding/` — all existing and new tests pass.
- [x] 7.2 Run `bun run type-check` in `agentic-coding/` — clean.
- [x] 7.3 Run `bun run dev:ui` (home mode): startup modal appears then dismisses; quit with `q` shows the shutdown modal, process exits, port 4318 released (`ss -ltn` shows nothing bound). Run `bun run dev:ui-dash`: dash quit behavior unchanged.
