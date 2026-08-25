## 1. Task viewport logic

- [x] 1.1 Add a small pure dashboard helper in `agentic-coding/src/tui/dash/data.ts` that finds the first incomplete task, computes the clamped five-row window (`start = clamp(activeIndex - 2, 0, taskCount - 5)`), and returns the visible tasks plus active position metadata, including the all-complete and empty-list cases.
- [x] 1.2 Add focused unit coverage in `agentic-coding/test/dash/data.test.ts` for centered active tasks, beginning/end boundary clamping, lists shorter than five tasks, empty lists, and all-complete lists.

## 2. Dashboard task panel

- [x] 2.1 Update `agentic-coding/src/tui/dash/App.tsx` to use the viewport helper, render up to five one-line task rows with accurate completion markers, visually distinguish the active row, and show the active one-based position and total count in the heading.
- [x] 2.2 Expand the task panel and its containing lower row to fit five content rows while preserving the existing Git status panel, task-panel focus, and full-list detail modal behavior.

## 3. Verification

- [x] 3.1 Run the focused dashboard tests, type-check, and Biome lint/format checks; verify the task viewport at normal and narrow supported terminal sizes and confirm no unrelated files change.
