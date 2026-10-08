# Tasks

## 1. Role

- [ ] 1.1 Write `agent-definitions/instructions/debug.md` (method, tool usage, evidence policy, report template) and register the role with its writable tool policy; verify role resolution in workflow step tests.

## 2. Workspace

- [ ] 2.1 Add detached attach to the worktree port and adapter; verify with a temp repository where the branch is checked out in the main checkout.

## 3. Family

- [ ] 3.1 Add `graphs/debug.ts` and `steps/debug.ts` (investigate, review gate with bounded follow-up, completed hold) and register them; verify registry validation (reachability, terminal paths, bounded cycle) and digest pin tests.
- [ ] 3.2 Validate the handoff contract (report headings) and produce `changes.patch` evidence for a dirty worktree; verify both.
- [ ] 3.3 Add `--branch`/`--app` start inputs to the CLI and the launch dialog/orchestrator workflow types; verify CLI parsing and launch.
- [ ] 3.4 Add the `debug` routing pool with default-profile fallback; verify routing.

## 4. TUI

- [ ] 4.1 Render `debug-report.md` and the review actions on the dashboard; open the TUI and confirm footer and `?` help for the gate keybinds.

## 5. Checks

- [ ] 5.1 Update the README workflow list.
- [ ] 5.2 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
