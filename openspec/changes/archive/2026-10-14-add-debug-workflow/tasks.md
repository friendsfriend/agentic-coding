# Tasks

## 1. Role

- [x] 1.1 Write `agent-definitions/instructions/debug.md` (method, tool usage, evidence policy, report template) and register the role with its writable tool policy; verify role resolution in workflow step tests. (The role brief is pinned under `debug.investigate`; the step declares `shell` and `edit` on top of the agent defaults, and `debug.investigate`/`debug.review` are registered in `steps/index.ts`. Verified by `test/debug-workflow.test.ts`.)

## 2. Workspace

- [x] 2.1 Add detached attach to the worktree port and adapter; verify with a temp repository where the branch is checked out in the main checkout. (`WorktreeEnsureInput.detached` creates the worktree through git (`git worktree add --detach`) — worktrunk cannot create one — and reuses it by path. Verified by the scripted argv test and the live worktrunk test in `test/worktree-port.test.ts`, which checks out `main` in the primary while creating a detached worktree at its head.)

## 3. Family

- [x] 3.1 Add `graphs/debug.ts` and `steps/debug.ts` (investigate, review gate with bounded follow-up, completed hold) and register them; verify registry validation (reachability, terminal paths, bounded cycle) and digest pin tests. (Registered in the triage-routing, stage-gate, step-routing and family-traits tiers; the `debug.investigate` route step `core.route-debug` is added to the routing catalog. Verified by `test/debug-workflow.test.ts` and the pinned digest in `test/workflow-registry.test.ts`.)
- [x] 3.2 Validate the handoff contract (report headings) and produce `changes.patch` evidence for a dirty worktree; verify both. (`core.debug-report` parses the report and requires every heading; the engine writes `debug-report.md` and, when dirty, `changes.patch` into the workflow data root before the handoff transaction, and the reducer records both as evidence entries. Verified by the contract cases in `test/debug-workflow.test.ts` and `test/debug-artifacts.test.ts`.)
- [x] 3.3 Add `--branch`/`--app` start inputs to the CLI and the launch dialog/orchestrator workflow types; verify CLI parsing and launch. (The CLI already carries `--branch`/`--app`; startup now validates the debug branch, pins `metadata.branch`, and skips the remote read; the launch dialog offers a `Branch to investigate` picker and forces worktree mode; the orchestrator's `sourceBranch` documents debug. Verified by `test/workflow-startup.test.ts` and `test/dash/newWorkflowModal.test.tsx`.)
- [x] 3.4 Add the `debug` routing pool with default-profile fallback; verify routing. (A classifiable step a preset leaves unpooled now falls back to the preset's `default_profile`, so the `fixed` preset starts a debug workflow without a `debug.investigate` pool. Verified by `test/debug-workflow.test.ts` and the debug startup test.)

## 4. TUI

- [x] 4.1 Render `debug-report.md` and the review actions on the dashboard; open the TUI and confirm footer and `?` help for the gate keybinds. (The artifact observation lists and renders `debug-report.md` for the debug family; the review gate reuses the shared review popup and its `approve-review`/`review-comments` actions, so no new keybind was added and the footer/`?` catalogs are unchanged. Verified by `test/dash/openspecArtifacts.test.ts`; no interactive TTY was available for a manual footer read.)

## 5. Checks

- [x] 5.1 Update the README workflow list.
- [x] 5.2 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
