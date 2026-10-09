# Proposal

## Why

`add-environment-instances` (archived) made several copies of one app run at
once: allocated `AC_PORT_*` ports, per-instance compose projects and image
tags, and a refusal of untemplated targets. Making every app, frontend binding
and compose file parallel-safe costs far more than it returns: routing between
apps, OAuth redirect URLs and proxy configs all assume static ports. Running
each app **once at a time**, with static routing and port mapping, keeps all
existing definitions valid. Agents that need an app another run holds wait for
it.

## What Changes

- **One run per app.** An app has one slot. It is held by exactly one owner
  (`user` or `workflow:<id>`), and the app runs from that owner's checkout with
  the definition's static names and ports. Runs of the same workflow (including
  debug sub-agents) share the slot.
- **Blocking wait.** A start for an app held by another owner waits in a FIFO
  queue per app. The start request long-polls; the tool layer
  (`add-agent-environment-tools`) turns that into a blocking tool call.
- **All-or-nothing and deadlock check.** A start may name several apps; it is
  granted only when all are free and it is first in every queue. A wait that
  would close a hold/wait cycle fails fast with `deadlock` naming the cycle.
- **Human runs are holders.** A run target observed running without an agent
  slot is held by `user`; agents wait for it. A human start of an app an agent
  holds is refused, naming the holder.
- **Force release.** `POST /api/v1/environment/apps/{app}/release` stops the
  holder's run and grants the next waiter. The holder's next call reports
  `released-by-developer`.
- **Toasts.** Events `environment.slot.waiting` and `environment.slot.granted`
  drive a shell toast: "<waiter> waits for <app> (held by <holder>)" and
  "<owner> got <app>".
- **Removed (BREAKING for the archived spec):** port allocator and
  `port_allocations`, `AC_PORT_*`, `AC_INSTANCE`, `AC_IMAGE_TAG`, the
  per-instance compose project (`-p <app>-<instance>`) and the
  `untemplated-target` refusal. `AC_OWNER` and `AC_APP_DIR` stay.

## Capabilities

### Modified Capabilities

- `environment-instances`: one slot per app instead of one instance per
  owner/app; blocking FIFO wait, multi-app acquisition, deadlock detection,
  human holders, force release, wait/grant notifications; template variables
  reduced to `AC_OWNER`/`AC_APP_DIR`; untemplated refusal removed.

## Impact

- `agentic-coding/src/server/runtime/instances.ts` (slot + queue replaces
  per-owner start), `src/server/environment/instances/{ports,variables,model}.ts`
  (allocator deleted, variables reduced), `state-store.ts` (v9: drop
  `port_allocations`, one active row per app), `src/server/actions/target-compile.ts`
  / `script-infrastructure.ts` / `docker.ts` (no per-instance project),
  `src/server/app.ts` + `protocol.ts` (routes), run-observation (user holder),
  the TUI run action path (refuse while agent holds), shell toast wiring
  (`src/tui/otel/app/notifications.ts`).
- Docs: rewrite `agentic-coding/docs/agent-environments.md`.
- Tests: `test/environment-instances.test.ts`, `test/environment-state.test.ts`,
  `test/runtime-app.test.ts`, `test/runtime-routes.test.ts`,
  `test/runtime-script-infrastructure.test.ts`.
