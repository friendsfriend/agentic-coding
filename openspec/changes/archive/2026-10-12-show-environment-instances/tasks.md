# Tasks

## 1. Data

- [x] 1.1 Keep a keyed slot store from `environment.slot.*` and start/stop events, re-snapshotting from `/api/v1/environment/apps/slots` on a gap; verify with a fake event stream.

## 2. View

- [x] 2.1 Add the Slots section (holder, waiters in order, wait time, idle/TTL) and the held-by-agent marker in the app list; verify with the OpenTUI test renderer.
- [x] 2.2 Add force release (with confirmation) and open-workflow; verify the routes called and the confirmation text.
- [x] 2.3 Declare the keybinds in the environment catalog; open the TUI and confirm the footer and `?` help list them.

## 3. Checks

- [x] 3.1 Run `bun run lint`, `bun run type-check` and the focused tests with zero diagnostics.

## Notes

- 1.1: `packages/devenv/cli/src/tui/stores/slot-store.ts` maps the snapshot and
  applies `environment.slot.waiting/granted/reaped` plus the legacy start/stop
  status stream; a domain `resync` re-reads the snapshot. Pure mapping/event
  functions are pinned by `slot-store.test.ts` (a fake event stream), and the
  SSE frames by `packages/devenv/core/src/domain-events-client.test.ts`.
- 2.1: the Slots tab renders `views/slots-view.tsx` (holder, status, endpoints,
  idle/TTL, waiters with wait time); `packages/ui/src/views/Table.tsx` marks an
  agent-held row with `agent-held` from the annotated `slotHolder`.
- 2.2: `views/../actions/slot-actions.ts` opens the confirm dialog naming the
  holder and the next waiter and calls `client.releaseApp(app)` (covered by the
  core client test); open-workflow resolves the owner to a workflow id and calls
  the shell's `onOpenWorkflow`.
- 2.3: the keymap layer (`keyboard/table-keymap-layer.ts`, context `slots`) and
  `keyboard/registry.ts` declare `x` "force release app" (short `release`) and
  `Enter` "open owning workflow" (short `open`); the embedded feature projects
  them into the shell footer/`?` help through `onKeybindCatalog`.
- The server slot view (`src/server/runtime/instances.ts`) carries the fields the
  spec names (endpoints, held-since, idle/TTL, waiter wait times and positions),
  and `packages/devenv/core` gained `releaseApp` and `subscribeDomainEvents`.
