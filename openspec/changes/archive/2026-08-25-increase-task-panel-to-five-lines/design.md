## Context

The dashboard renders the task panel in `agentic-coding/src/tui/dash/App.tsx` as a two-line panel: one header and one content line containing the first incomplete task. The dashboard data already exposes ordered tasks with `done` and `text` fields, and the existing detail modal lists the complete task set. The requested change is a presentation-only improvement; workflow state and task-file parsing do not need to change.

The surrounding lower dashboard row currently reserves five terminal lines for a two-line Current task panel, a one-line gap, and a two-line Git status panel. OpenTUI panel height includes its header, so five task content rows require a six-line task panel and a nine-line lower row while leaving Git status unchanged.

## Goals / Non-Goals

**Goals:**

- Render an ordered viewport of up to five task content rows.
- Keep the first incomplete task as the active task and center it when the list has enough items on both sides.
- Clamp the viewport at the beginning and end so the first and last tasks occupy the corresponding boundary row without blank padding.
- Expose the active task's one-based position and total task count in the panel heading.
- Preserve completion markers, active-panel focus, and the existing full task-list modal.

**Non-Goals:**

- Changing task parsing, task-file format, workflow progression, or persistence.
- Introducing a new per-task runtime state beyond the existing first-incomplete-task convention.
- Adding scrolling or keyboard navigation inside the task panel; the full list remains available through the existing modal.
- Changing the Git status panel or the overall dashboard pane grid.

## Decisions

1. **Compute the viewport from the existing ordered task array.** Derive the active index as the first task whose `done` flag is false. For a five-row viewport, choose `start = clamp(activeIndex - 2, 0, max(0, taskCount - 5))`, then render `tasks.slice(start, start + 5)`. This centers the active task when possible and naturally pins it near the beginning or end. If every task is done, render the final five tasks and show a completed count; if there are no tasks, render the existing empty-state text.

   The alternative of adding a new `activeTask` field to workflow state would duplicate information, require changes to persistence/contracts, and still need a fallback for older workflows. The existing ordered task data is sufficient for this display.

2. **Use one content line per visible task and a six-line task panel.** Each row will retain the completion marker and task text, with the active row visually distinguished. The lower dashboard row will grow only enough to accommodate the task panel plus its existing gap and Git panel. This avoids clipping while preserving the current Git status placement.

   Making the task panel flex to consume all remaining height was rejected because its visible row count would vary with terminal size and would not guarantee the requested five rows.

3. **Derive the count from the active index rather than completed count.** The header will show the active task's one-based position and total number of tasks (for example, task 5 of 10). When all tasks are complete, it will show the total as complete rather than claiming that an active task exists. This distinguishes the task being worked on from a raw completed-task count if task completion is non-contiguous.

4. **Keep the existing modal as the full-list view.** Enter on the task panel will continue to open every task with its completion marker, so the five-row viewport is a glanceable summary rather than a replacement for task inspection.

## Risks / Trade-offs

- **[Risk] A task list with non-contiguous completion can have a completed task after the active task.** → Keep the active-row calculation tied to the first incomplete task and retain each task's own completion marker; do not infer completion from position.
- **[Risk] A small terminal height may not fit the expanded lower row.** → Use fixed heights that match the five content rows and retain `minHeight: 0`/overflow behavior used by the surrounding layout; verify the dashboard at the supported minimum terminal size.
- **[Trade-off] The active task is inferred from the first incomplete item, not an explicit worker event.** → Preserve the current data model and document this as the dashboard's active-task convention; a true per-task runtime signal can be introduced separately if the workflow later supplies one.

## Migration Plan

No data or deployment migration is required. Update the dashboard rendering and its focused tests, then validate at normal and narrow terminal sizes. Rollback is a code revert; existing task files and workflow state remain compatible.

## Open Questions

- None for this presentation-only implementation. The first incomplete task remains the definition of the currently worked-on task used by the existing dashboard.
