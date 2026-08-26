## Context

The detail dashboard in `agentic-coding/src/tui/dash/App.tsx` currently renders a primary Change panel, Agents, Current task, and a separate two-line Git status panel. `agentic-coding/src/tui/dash/data.ts` already has `worktreeGitStatus`, which performs one best-effort porcelain Git inspection and classifies distinct changed, added, and deleted paths while parsing upstream ahead/behind counts. The detail loader currently reduces that result to `health.dirty`, `health.ahead`, `health.behind`, and `health.branch`, so the overview cannot render the required breakdown.

The change is a read-only dashboard presentation change. Workflow state, Git commands, workspace effects, and the existing changed-files review modal remain outside the scope of the layout consolidation.

## Goals / Non-Goals

**Goals:**

- Make the primary Change panel the single visible location for worktree Git status.
- Preserve the existing Git classification rules, metadata exclusion, upstream semantics, and bounded diagnostics.
- Display changed, new, deleted, ahead, and behind values in a compact, refreshable overview summary.
- Remove the standalone Git panel and its focus/navigation slot without disturbing Change, OpenSpec, Agents, or Current task interactions.
- Keep the detail dashboard's row widths and panel grid valid at narrow terminal sizes.

**Non-Goals:**

- No changes to workflow-engine state or Git mutation operations.
- No new external dependency, Git API, or persisted schema.
- No redesign of the Home workspace list or the developer-review changed-files modal.
- No new Git interaction such as launching a Git client; the summary remains read-only.

## Decisions

1. **Reuse `worktreeGitStatus` as the source of truth.** Extend the dashboard data contract to carry the structured `WorktreeGitStatus` result (or an equivalent complete Git-status shape) instead of deriving counts in the renderer or issuing additional Git commands. This preserves path de-duplication and keeps overview values consistent with the existing inspector. Alternatives rejected: parsing `health.dirty` (loses the breakdown) and running one Git command per count (duplicates I/O and can produce inconsistent snapshots).

2. **Render status in the Change/overview panel.** Add a compact Git summary row/section to the existing primary panel, including branch when available, changed/new/deleted file counts, and ahead/behind commits. Use the existing dashboard colors and overflow behavior. When inspection is unavailable, show the bounded diagnostic; when no upstream is configured, show an explicit no-upstream marker rather than implying zero divergence. Alternatives rejected: retaining a second panel (duplicates information) and showing only a colored dirty/clean label (does not satisfy the required counts).

3. **Remove Git from the focus model.** Delete the standalone panel markup, remove panel index `4` from the Tab/Shift-Tab order, and remove its Enter-specific changed-files action. Existing review-phase entry points continue to open the changed-files modal, while the overview remains a display surface. Alternatives rejected: leaving an invisible focus target or moving the old Enter behavior onto the overview, both of which would preserve confusing panel-specific behavior after removal.

4. **Keep status calculation best-effort and refresh-driven.** Load the Git snapshot with the rest of `loadDashboard`; retain zero/undefined distinctions from `WorktreeGitStatus` and refresh through the existing dashboard watcher/manual refresh path. No status failure may prevent the workflow dashboard from rendering. Alternatives rejected: making Git inspection a workflow-engine prerequisite or silently replacing unavailable values with zero.

## Risks / Trade-offs

- [Risk] The overview gains several lines and may reduce space for the request text on small terminals → Keep the summary compact, use existing bounded content containers, and verify rendering at the focused dashboard test width and a narrow width.
- [Risk] Removing the panel changes Tab navigation and invalidates tests that assume its index → Update the focus-order and Enter behavior tests together with the UI, and retain direct review entry paths.
- [Risk] Git headers differ for detached, unborn, and missing-upstream branches → Reuse the existing parser and render explicit unavailable/no-upstream states rather than inventing counts.

## Migration Plan

1. Extend the dashboard data fixture/loader contract and add focused data assertions for the complete status shape.
2. Move the status summary into the Change/overview panel and remove the standalone panel plus focus handling.
3. Update dashboard rendering and interaction tests, including narrow-layout coverage where applicable.
4. Run formatting, type checking, and focused dashboard tests; no deployment or persisted-data migration is required.

Rollback is a source revert: the existing Git inspector and standalone-panel implementation can be restored without data migration.

## Open Questions

- None. The existing `worktreeGitStatus` semantics define classification and upstream behavior; the implementation only needs to expose and render its complete result.
