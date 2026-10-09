# Tasks

## 1. Data

- [ ] 1.1 Keep a keyed slot store from `environment.slot.*` and start/stop events, re-snapshotting from `/api/v1/environment/apps/slots` on a gap; verify with a fake event stream.

## 2. View

- [ ] 2.1 Add the Slots section (holder, waiters in order, wait time, idle/TTL) and the held-by-agent marker in the app list; verify with the OpenTUI test renderer.
- [ ] 2.2 Add force release (with confirmation) and open-workflow; verify the routes called and the confirmation text.
- [ ] 2.3 Declare the keybinds in the environment catalog; open the TUI and confirm the footer and `?` help list them.

## 3. Checks

- [ ] 3.1 Run `bun run lint`, `bun run type-check` and the focused tests with zero diagnostics.
