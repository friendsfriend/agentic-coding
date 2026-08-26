## Context

The dashboard detail view renders the worktree Git status in the primary Change/overview panel. `worktreeGitStatus` already distinguishes a usable upstream from a missing or gone upstream, and `App.tsx` renders the latter as a muted inline `no upstream` segment in the existing horizontally clipped status row. This change is a presentation-only refinement to reduce the row's width.

## Goals / Non-Goals

**Goals:**

- Render `` as the muted marker for a missing or unusable upstream.
- Preserve the existing conditional rendering: no arrow counts when no upstream is usable, while file counts and branch remain visible.
- Preserve the existing single-line, clipped layout and all other status colors.
- Add or update focused rendering coverage for the glyph and ensure the textual label is absent.

**Non-Goals:**

- No changes to Git inspection, upstream detection, status data, or refresh behavior.
- No changes to the usable-upstream count segments, branch display, unavailable-worktree diagnostic, or other dashboard panels.
- No font, icon dependency, API, or workflow-state changes.

## Decisions

- **Use the literal `` glyph in the existing fallback text node.** The requested glyph is already a terminal-renderable character and the current fallback node supplies the correct muted styling and non-wrapping behavior. Reusing that node limits the implementation to a presentation replacement and avoids adding an icon abstraction or dependency.
- **Keep the existing `Show` branch on `noUpstream`.** Upstream availability is already represented by the data model and controls whether arrow counts are shown. Only the label content changes; preserving this branch avoids altering Git-status semantics.
- **Cover the display contract at the dashboard rendering boundary.** A focused TUI test should render a no-upstream overview and assert that `` is present while `no upstream` is not. Existing data tests remain relevant to upstream detection but need no semantic changes.

## Risks / Trade-offs

- [Risk] The glyph may not be available in a user's terminal font. → Mitigation: use the exact requested glyph and retain its muted visual role; no fallback text is introduced because the compactness goal depends on removing the long label.
- [Risk] A snapshot or character-frame assertion could be sensitive to unrelated layout details. → Mitigation: assert only the presence/absence of the status marker text at the focused rendering boundary.

## Migration Plan

No migration or deployment sequencing is required. Change the fallback label, update focused tests/specification, run the project's lint, type-check, and relevant test suite, and roll back by restoring the prior text if needed.

## Open Questions

None.
