# Tasks

## 1. Pure per-tab latest-per-role selection

- [x] 1.1 Add a pure helper in `src/workflow/tab-status.ts` that takes runs (`{ role, status, tabId? }`) and returns `tabId -> latest status per role`, where the last run for a role in creation order wins; ignore runs without a `tabId`. Verify with new cases in `test/workflow-tab-status.test.ts` (superseded `failed`/`blocked`/`working` ignored, multiple roles on one tab, no-tab runs skipped) via `bun test test/workflow-tab-status.test.ts`.

## 2. Reconcile uses the latest run per role

- [x] 2.1 Update `syncAgentTabLabels` in `src/workflow/tab-sync.ts` to build its per-tab status lists from the helper instead of pushing every run's status. Verify with new cases in `test/workflow-tab-sync.test.ts`: an earlier `failed` and an earlier `blocked` run each stop pinning the tab once the role's latest run is `completed` (renames to `✓`), and a latest `working` run renames the tab to `●` after an earlier `completed` run.
- [x] 2.2 Confirm the existing reconcile cases still hold by running `bun test test/workflow-tab-sync.test.ts` (idempotent match issues no rename; missing workspace, runs without tabs, closed tabs, and Herdr failure are all no-ops/non-throwing).

## 3. Reused pane records its tab id

- [x] 3.1 Update the reuse branch of `paneForRunFactory` in `src/workflow/cli/pane.ts` to return the resolved live agent's `tabId` alongside `paneId`/`owned`, without changing the fresh-launch branch. Verify by extending the reused-pane case in `test/workflow-cli.test.ts` so the fake `agent get` returns a `tab_id` and the result includes it, then `bun test test/workflow-cli.test.ts`.

## 4. Validation

- [x] 4.1 Run the focused checks from `agentic-coding/`: `bun run type-check`, `bun run lint`, and `bun test test/workflow-tab-status.test.ts test/workflow-tab-sync.test.ts test/workflow-cli.test.ts`.
- [x] 4.2 Record the changed files and the focused check results in the implementation handoff.
