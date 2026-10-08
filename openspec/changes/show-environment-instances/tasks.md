# Tasks

## 1. Events

- [ ] 1.1 Publish `environment.instance.*` events from the instance manager and queue; verify payloads and sequence.

## 2. View

- [ ] 2.1 Add the Instances and Queue sections with live store and gap re-snapshot; verify with OpenTUI test renderer.
- [ ] 2.2 Add stop (with confirmation) and open-workflow actions; verify routes called and `user` vs agent behavior.
- [ ] 2.3 Declare keybinds in the environment catalog; open the TUI and confirm footer and `?` help.

## 3. Checks

- [ ] 3.1 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
