## 1. Remove the task-panel surface

- [x] 1.1 Remove the Current task rendering, task-detail Enter action, and task-panel-only dashboard data/view-model fields while retaining shared task parsing used by workflow overview counts.
- [x] 1.2 Collapse `panel-grid.ts` to Change, optional OpenSpec, and spanning Agents cells, removing the Current task id and updating directional wrap/no-neighbor behavior.

## 2. Bound the OpenSpec panel

- [x] 2.1 Size the existing OpenSpec `SelectableList` panel to at most five artifact rows without slicing its items, so its existing focused selection and scroll-into-view behavior exposes all artifacts.

## 3. Verify dashboard behavior

- [x] 3.1 Replace task viewport and Current task navigation assertions with transition-table and rendered dashboard tests for the reduced panel grid, including artifact-present and artifact-absent navigation.
- [x] 3.2 Add a focused OpenSpec interaction test with more than five artifacts that verifies only five rows are visible initially and `j`/`k` navigates and scrolls lower artifacts without changing panel focus; retain an activation assertion for the selected formatted artifact view.
- [x] 3.3 Run `bun test test/dash/panelGrid.test.ts test/dash/panelNavigation.test.tsx test/dash/data.test.ts test/dash/userActions.test.tsx`, `bun run type-check`, and `bun run lint` from `agentic-coding/`.