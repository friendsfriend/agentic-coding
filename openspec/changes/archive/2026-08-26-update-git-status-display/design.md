## Context

The agent-dash overview panel (`agentic-coding/src/tui/dash/App.tsx`, GIT STATUS section ~lines 2229–2291) renders the worktree's git status as seven vertical labeled rows: BRANCH, then mapped CHANGED/NEW/DELETED counts, then AHEAD/BEHIND (with a duplicated `no upstream` fallback). The developer asked for all of this information in one compact line of the form `+{new}*{changed}-{deleted} ↑{ahead} ↓{behind} {branch}` with green/yellow/red/green/green/regular coloring.

Data comes from `WorktreeGitStatus` (`src/tui/dash/data.ts`), which already exposes `addedFiles`, `changedFiles`, `deletedFiles`, `ahead?`, `behind?`, `noUpstream`, and `branch?`. No inspection changes are needed.

This change fuses two convergent planner drafts; both proposed the same approach (single overflow-hidden colored row in App.tsx plus test updates in `test/dash/userActions.test.tsx`). Rejected alternatives are recorded under Decisions.

## Goals / Non-Goals

**Goals:**
- One horizontal status line containing new, changed, deleted, ahead, behind counts and the branch name — nothing lost versus today's display.
- Requested segment coloring via existing theme tokens (`uiColors.success`, `uiColors.warning`, `uiColors.error`, `uiColors.textSecondary`).
- Line stays bounded within the panel at narrow widths (existing ≤50-column test constraint).
- Keep the `GIT STATUS` header, unavailable-worktree diagnostic fallback, and all data-inspection behavior unchanged.

**Non-Goals:**
- Changing git inspection logic, `.herdr-workflow` exclusion, or refresh semantics (`data.ts` untouched).
- Interactive features (e.g. clicking segments to open a git panel).
- Hiding zero-count segments or adding tooltips/legends.

## Decisions

- **Single `<box flexDirection="row" overflow="hidden">` with one `<text>` per colored segment**, wrapped in the existing `Show when={data().gitStatus.branch}` guard. Why: OpenTUI colors are per-text-node, so adjacent siblings give exact color boundaries with no gaps (the row box must not set a gap); `overflow="hidden"` keeps the line clipped instead of wrapping at narrow widths. Alternative considered: building one string and coloring it whole — rejected because the format requires five distinct colors on one line.
- **Always render zero counts** (`+0*0-0`). Why: the task asks for "all the informations … in one line"; omission would make the line ambiguous about whether a category is zero or unsupported. Alternative considered: hide empty segments for a cleaner look — deferred as a possible follow-up if the developer prefers it after review.
- **`↑` / `↓` glyphs for ahead/behind.** The task text's arrow characters arrived stripped; `↑` (ahead) and `↓` (behind) are the conventional git-prompt symbols matching the requested green coloring. ASCII fallbacks (`^`/`v`) would deviate from the requested look; revisit only if terminal-font issues appear in practice.
- **One shared muted `no upstream` segment** replacing both arrow slots when `gitStatus.noUpstream` is true. Why: today's UI duplicates "no upstream" across two rows purely because each row has a label; in the single-line format duplication wastes width without adding information.
- **Branch last, regular secondary text** (`uiColors.textSecondary`) exactly as requested, so long branch names are what gets truncated by `overflow="hidden"` first — counts stay visible.
- **Update tests to assert the compact format**: `test/dash/userActions.test.tsx` swaps `toContain("CHANGED"/"NEW"/"DELETED"/"AHEAD"/"BEHIND")` for assertions on the compact markers (e.g. `+0*0-0`, branch name) derived from TestDashboard's mocked gitStatus (all zeros, upstream present), and the narrow-width test verifies the row still fits ≤50 columns.

## Risks / Trade-offs

- [↑/↓ glyph width or availability varies by terminal font] → Counts are plain digits between spaces, so even double-width rendering shifts only that segment; narrow-width test guards total layout. Fall back to ASCII if real terminals misrender.
- [Combined line is longer than any old row; very long branch names get truncated] → Accepted trade-off requested by the design; `overflow="hidden"` clips gracefully and counts remain visible.
- [Existing tests hard-code old labels] → Both affected tests are updated in the same change; no other tests assert these labels.
- [Removing textual labels reduces standalone clarity] → Mitigated by consistent symbol ordering (`+ * - ↑ ↓`), stable colors per category, and the retained `GIT STATUS` header context.
- [Implicit inter-child gaps inside a flex row would insert unwanted spaces between segments] → The row box omits any `gap` setting; verified against sibling rows in the same panel which render flush.

## Migration Plan

Purely presentational, single-panel change deployed with the normal dashboard build. Rollback is reverting the App.tsx JSX block and test assertions. No data migration.

## Open Questions

- None blocking. Two preference questions were resolved conservatively for this proposal and can be revisited during plan review: (1) zero-count visibility (currently always shown) and (2) glyph choice for ahead/behind (currently `↑`/`↓`).
