# Tasks

## 1. Data

- [x] 1.1 Load the `evidence` observation for the open workflow and refresh on evidence events; verify with a fake client. (`src/tui/data/evidence.ts`, cache invalidation for workflow events, `test/data/evidence.test.ts`)

## 2. Panel

- [x] 2.1 Add `EvidencePanel.tsx` listing entries grouped by debug request; verify rendering with OpenTUI test renderer.
- [x] 2.2 Add inline preview through OpenTUI's image renderable when kitty transport is available and metadata-only preview otherwise; verify both branches with a stubbed capability.
- [x] 2.3 Add external open via `side-app.ts` and path copy; verify the opener command per platform.

## 3. Keybinds

- [x] 3.1 Declare the panel keybinds in `src/tui/dash/keybinds.ts`; open the TUI and confirm footer and `?` help list them.

## 4. Checks

- [x] 4.1 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
