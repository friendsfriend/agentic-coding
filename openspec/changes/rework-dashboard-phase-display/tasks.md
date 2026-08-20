## 1. Dashboard STATUS row

- [x] 1.1 In `src/tui/dash/App.tsx`, rewrite the `workflowStatus` memo so `text` is always `data().state.stepLabel ?? data().state.phase`, removing the `data().agents.find(agent => agent.status === "working")` lookup and the role-based "Planning"/"Verifying"/"Applying" substitution.
- [x] 1.2 Derive `workflowStatus().working` from workflow terminality (e.g. `data().state.status` not in `["completed", "closed"]`, falling back to the same phase-string check when `status` is absent) instead of from any agent's busy state.
- [x] 1.3 Confirm the Change panel's STATUS `Badge` still receives `text`/`highlight`/`animation` from `workflowStatus()` unchanged in structure, only the underlying values change.

## 2. Test updates

- [x] 2.1 Update `test/dash/userActions.test.tsx` to stop waiting on the removed "Verifying" label; wait on the actual phase text shown at that demo step (the `verify` phase value) or another stable marker already present in that frame.
- [x] 2.2 Run the dashboard test suite (`bun test test/dash`) and confirm no other test asserts on the removed "Planning"/"Verifying"/"Applying" labels. (Also found and fixed a knock-on issue: terminality-based `working` now keeps the STATUS badge's aurora animation active through the whole `proposed` demo phase, which broke two `t.flush()`-based waits in `test/dash/userActions.test.tsx` via `waitForVisualIdle` timeouts; switched those calls to `t.renderOnce()` per planner direction.)

## 3. Verification

- [x] 3.1 Manually trace through each `demoPhases` step (`proposed`, `apply`, `verify`, `developer-review`, `archive`, `completed`) confirming the STATUS row shows the raw phase/stepLabel at every step, independent of which agent (if any) is `working`.
- [x] 3.2 Confirm the Agents panel is unaffected and still shows individual agent statuses as before.
