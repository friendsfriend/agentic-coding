# Tasks

## 1. Remove the parallel machinery

- [x] 1.1 Delete the port allocator (`src/server/environment/instances/ports.ts`) and its callers, plus `AC_PORT_*`, `AC_INSTANCE` and `AC_IMAGE_TAG` in `variables.ts`, so only `AC_OWNER` and `AC_APP_DIR` remain; verify in `test/environment-instances.test.ts`.
- [x] 1.2 Remove the per-instance compose project from compile and docker execution, and the `untemplated-target` refusal; verify compiled argv in `test/runtime-app.test.ts` matches pre-instance behavior.
- [x] 1.3 Add state v9 (drop `port_allocations`, unique active row per app, resolve parallel-era duplicates as designed) in `state-store.ts`; verify v8 fixtures with duplicates, idempotent reopen and future-schema refusal in `test/environment-state.test.ts`.

## 2. Slot and queue

- [x] 2.1 Implement occupancy from active rows plus run observation (`user` holder for unowned observed runs, unobservable = occupied); verify all three cases.
- [x] 2.2 Implement the global-sequence FIFO queue with multi-app entries, all-or-nothing grant, 60 s position grace and expiry; verify ordering, multi-app grant and expiry with an injected clock.
- [x] 2.3 Implement wait-for graph deadlock detection; verify a two-owner cycle fails with `deadlock` naming both owners and apps, and that `user` never forms a cycle.
- [x] 2.4 Keep a waiting owner's held slots active (activity hook for lifecycle); verify.

## 3. API

- [x] 3.1 Replace the v8 instance routes with `acquire` (long-poll, `waitSec ≤ 300`), `release`, `stop` and `slots`, register them in `protocol.ts` and the route ownership manifest; verify outcomes `started`, `already-running`, `waiting`, `deadlock` and `released-by-developer` in `test/runtime-routes.test.ts`.
- [x] 3.2 Make the TUI run action check the slot and refuse with the holder when an agent holds the app; verify.

## 4. Notifications

- [x] 4.1 Publish `environment.slot.waiting` once per new queue entry and `environment.slot.granted` on grant; verify payloads and no duplicate on re-poll.
- [x] 4.2 Subscribe in the shell and raise warning/info toasts with workflow titles; verify with the notification test helpers (`resetNotifications`).

## 5. Checks

- [x] 5.1 Rewrite `agentic-coding/docs/agent-environments.md` for the slot model.
- [x] 5.2 Run `bun run lint`, `bun run type-check` and the focused tests in `agentic-coding/` with zero diagnostics.
