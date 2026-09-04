## Context

The detail dashboard currently reserves a full-width Current task row below the Change/OpenSpec and Agents columns. Its panel id, task viewport, activation path, and tests exist only for that presentation. The OpenSpec panel already uses `SelectableList`, which scrolls the selected row into view; its unbounded height is the remaining issue.

## Goals / Non-Goals

**Goals:**
- Remove the Current task dashboard presentation and its focus target without changing workflow task data used elsewhere.
- Keep Change, optional OpenSpec, and Agents as the only detail panels with predictable Shift+J/K/H/L navigation.
- Cap the OpenSpec panel at five artifact rows while preserving selection, automatic scroll-into-view, and Enter-to-open behavior.

**Non-Goals:**
- Changing OpenSpec artifact discovery, Markdown rendering, workflow task execution, or overview task counts.
- Adding mouse scrolling, pagination controls, a new list component, or dependencies.

## Decisions

### Use the existing selectable list for bounded OpenSpec scrolling

Set the OpenSpec panel height from `min(artifact count, 5)` rather than rendering a sliced artifact array. `SelectableList` already owns a scrollbox and scrolls the selected child into view, and the detail key handler already changes the selected artifact for focused `j`/`k` and arrow input. This retains access to every artifact with the smallest change.

Alternative: add a custom viewport or a separate scroll offset. Rejected because it duplicates existing scroll/selection behavior and risks selection falling outside the rendered slice.

### Collapse panel geometry to the remaining two rows

Remove the Current task panel id and third grid row. The grid retains Change at top-left, optional OpenSpec below it, and Agents spanning the right column. Directional navigation wraps or remains on the active panel when no distinct rendered neighbor exists.

Alternative: retain a hidden placeholder row to preserve old navigation. Rejected because it creates invisible focus behavior after the panel is removed.

### Delete only task-panel-specific dashboard data

Remove the task viewport helper, its tests, and detail-only `DashboardData` task/current-task fields if they have no remaining callers. Keep the shared task parser and task type used by workflow overview counts.

Alternative: retain unused task panel data for possible restoration. Rejected as dead code with no current consumer.

## Risks / Trade-offs

- [More than five artifacts hide lower rows] → Selection changes made by focused `j`/`k`/arrow keys continue to call the existing list's scroll-into-view behavior; add a rendered interaction test covering a list beyond the visible cap.
- [Grid rewiring changes wrap behavior] → Replace the transition-table tests and dashboard navigation tests to assert every direction for artifact-present and artifact-absent layouts.
- [Removing dashboard task fields affects overview counts] → Limit deletion to fields and helpers with no callers; keep and test the parser path that powers overview task counts.
