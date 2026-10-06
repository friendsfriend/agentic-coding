# Tasks

## 1. Detection

- [ ] 1.1 Add the pure transition detector and projection (`src/tui/orchestrator/transitions.ts`). Verify with unit tests: first observation is silent; review entered, question pending, attention required, failed effect and completion each yield one transition; a cleared-then-returned obligation yields a new one.
- [ ] 1.2 Add `[agents.orchestrator] monitor` (`wake` | `notify` | `off`, default `wake`) to config parsing, the `set-orchestrator` mutation and the Settings picker/inventory. Verify parse/reject tests and the inventory test.

## 2. Monitor and delivery

- [ ] 2.1 Add `monitor.ts`: subscribe to workflow events, debounce per workflow, re-read only orchestrator-started workflows, handle `resync`. Verify with a test against an injected gateway emitting events and views.
- [ ] 2.2 Deliver coalesced notes to the active session (`followUp`, 10 s window, ≤ 1 per 60 s) and raise shell notifications for human-needed transitions. Verify with fake timers: three transitions in one window produce one note; a burst beyond the bound is merged.
- [ ] 2.3 Start the monitor with the shell and stop it on shutdown; ensure the orchestrator host without opening the page. Verify in the TUI that an approval step on an orchestrator-started workflow notifies and appears in the session.
- [ ] 2.4 Update `docs/orchestrator.md`; run `bun run lint`, `bun run type-check` and the focused suites.
