# Tasks

## 1. Data

- [ ] 1.1 Load the `evidence` observation for the open workflow and refresh on evidence events; verify with a fake client.

## 2. Panel

- [ ] 2.1 Add `EvidencePanel.tsx` listing entries grouped by debug request; verify rendering with OpenTUI test renderer.
- [ ] 2.2 Add inline preview through OpenTUI's image renderable when kitty transport is available and metadata-only preview otherwise; verify both branches with a stubbed capability.
- [ ] 2.3 Add external open via `side-app.ts` and path copy; verify the opener command per platform.

## 3. Keybinds

- [ ] 3.1 Declare the panel keybinds in `src/tui/dash/keybinds.ts`; open the TUI and confirm footer and `?` help list them.

## 4. Checks

- [ ] 4.1 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
