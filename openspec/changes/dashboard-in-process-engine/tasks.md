# Tasks — dashboard-in-process-engine

## Shared Herdr client (R4)

- [ ] **T1** Extract one Herdr client module (single `.result` envelope parser + shared pane-geometry helpers) used by both the engine and the dashboard.
- [ ] **T2** Replace the multiple `.result` parse sites in `data.ts` and the duplicated geometry math in `focusAgent` with the shared client.

## In-process engine (R4)

- [ ] **T3** Replace `Bun.spawn("herdr-workflow", …)` calls in the dashboard (`runWorkflow`, `startWorkflow`, status/config/projects reads) with direct in-process engine calls.
- [ ] **T4** Keep the `herdr-workflow` shim for agent use; only the dashboard switches to in-process.

## Event-driven refresh (R5)

- [ ] **T5** Replace the 5s `setInterval(refresh, …)` re-spawn loop with an event/watch-driven refresh that tails `telemetry.jsonl` / `traces.jsonl` and watches workflow-state files.
- [ ] **T6** Retain a low-frequency safety re-sync and confirm no busy git/herdr re-spawn per cycle.

## Validation

- [ ] **T7** Add tests for the shared Herdr client parsing and the watch-driven refresh trigger.
- [ ] **T8** Run `openspec validate dashboard-in-process-engine` and resolve structural errors.
