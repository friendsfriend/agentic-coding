## Context

The dashboard currently uses a source-line `<text>` loop for `MarkdownViewModal`, so Markdown syntax is displayed literally. `loadWikiSnapshotDiff` currently concatenates the current document with a sentinel and a second textual diff, and the plan/wiki branch renders that result through the Markdown modal rather than through the developer diff presentation. The existing `DiffViewModal` already owns selectable unified/split rows, source-line callbacks, inline discussions, navigation, and the green/red diff palette. OpenTUI provides native Markdown rendering and the project already uses its syntax-style API; no new parser dependency is needed.

See `proposal.md` for motivation and the modified capability deltas for the externally visible contract.

## Goals / Non-Goals

**Goals:**

- Render plan artifacts and wiki concept content as readable Markdown while preserving source-line selection and comment anchors.
- Give wiki review a valid snapshot-to-current unified diff that can be displayed by the same review interaction model as developer review.
- Keep only current-document wiki lines commentable, while still showing removed snapshot lines for review.
- Preserve the existing review list, keyboard navigation, postpone/finish behavior, developer review, and workflow/approval state contracts.

**Non-Goals:**

- Changing wiki storage, snapshot creation, approval effects, workflow transitions, or review comment persistence formats.
- Adding image rendering, hyperlink launching, editing, or a new Markdown dialect beyond the capabilities already supported by OpenTUI.
- Replacing the developer review modal or changing its existing behavior.

## Decisions

### Use a source-line Markdown adapter for document review

Extend the existing Markdown modal with a small shared source-line renderer backed by OpenTUI's native Markdown renderable and a `SyntaxStyle` instance. Each source line remains inside a stable wrapper with the existing `line-N` identity, selection background, mouse handler, and comment insertion point. The adapter maps visual rows back to source-line indices, preserves blank lines, conceals Markdown delimiters where OpenTUI supports them, and tracks fenced-code state so the contents of a multi-line code block retain code presentation without losing their source-line anchors. This keeps navigation and comments controlled by `App.tsx`, as required by the OpenTUI keyboard limitation, while replacing literal source text with rendered Markdown.

A monolithic Markdown child was considered, but it does not expose the source offsets needed for line/range comments and would make scrolling and comment insertion unreliable. A new third-party Markdown parser was rejected because OpenTUI already provides the renderer and the change does not need another dependency.

### Route wiki documents through the developer diff interaction model

Change the wiki review branch in `App.tsx` to render `DiffViewModal` instead of `MarkdownViewModal`. Add the smallest component-level option needed for Markdown content rendering in diff rows, while retaining the existing row selection, comments, visual mode, file navigation, and theme-driven added/removed colors. Wiki rows will use the current side for comment source mapping; selecting a removed-only row produces no commentable current line and the parent displays the existing bounded warning. Developer review continues using its current two-sided mapping and finding controls.

Reusing the existing diff modal was chosen over a second wiki-specific diff component because it already implements unified and split layouts, comments, scrolling, selection, and color semantics. A separate wiki viewer would duplicate those behaviors and risk diverging from developer review.

### Produce a standard unified wiki diff

Replace the sentinel-plus-current-content representation from `loadWikiSnapshotDiff` with a valid unified diff containing `---`/`+++` headers, a hunk header with accurate old/new ranges, and line prefixes for context, additions, and removals. Keep the existing LCS-based comparison so line counts remain deterministic and meaningful. Represent new and deleted concepts with the appropriate empty side and pass the existing `newFile`/`deletedFile` flags into the diff modal. The data layer remains responsible only for reading the snapshot/current documents and constructing review data; it does not alter the snapshot or wiki bundle.

A sentinel was previously used to distinguish commentable current content from snapshot context, but it is not a diff format and prevents the normal diff parser from assigning line numbers. Standard hunk metadata makes current line numbers available to the existing review callbacks and lets the UI handle additions, removals, and context consistently.

### Keep wiki comment anchors on the current side

Extend the diff source-line mapping with an explicit current-side-only mode (or equivalent callback result) for wiki review. The selected current line or current side of a paired row supplies `line`, `startLine`, and `endLine`; a removed-only row supplies no writable source range. The parent uses that distinction to reject comments on snapshot-only content, while existing developer review continues to allow its established new/old position behavior. Local discussion rendering filters by the concept path as it does today.

### Test at the rendering and integration boundaries

Add focused OpenTUI frame tests for a plan artifact containing headings, emphasis, lists, links, and fenced code, asserting rendered output and retained line commenting/navigation. Add data/component tests for standard wiki hunk output, correct old/new line numbers, additions/removals, new/deleted concepts, current-side commentability, and green/red row styling. Extend the existing dashboard user-action flow coverage to open a wiki review, inspect the changed-concept list, enter its diff, and return/finish without changing workflow state semantics. Keep validation focused on these changed paths; the workflow-owned test verifier remains responsible for the complete configured suite.

## Risks / Trade-offs

- [Risk] Markdown block rendering can change visual height or conceal source markers, making source-line-to-row mapping fragile. → Mitigation: retain one stable source-line wrapper and explicit source indices for every line, preserve blank/fence lines, and test selection/comment anchors after rendering.
- [Risk] A malformed or unusual Markdown document may not render identically to a browser. → Mitigation: rely on OpenTUI's supported Markdown behavior, preserve raw content as the source of truth, and keep a readable fallback for unsupported constructs.
- [Risk] Existing wiki snapshots may have no changed lines or represent missing concepts. → Mitigation: emit valid zero-sided hunks and keep added/deleted flags so the diff remains reviewable without fabricating current lines.
- [Risk] Changing wiki line numbering could invalidate old local review comments. → Mitigation: use current-document line numbers from the new hunk parser, preserve the existing comment JSON shape, and treat comments from a prior layout as ordinary persisted discussions rather than rewriting them.
- [Risk] Sharing diff presentation may accidentally expose developer-only finding controls in wiki review. → Mitigation: gate finding-specific controls and discussions on `reviewKind === "developer"`; wiki retains only normal concept comments and current-side restrictions.

## Migration Plan

No data migration is required. Implement the renderer and standard diff output, update the dashboard branch selection, and add focused tests. Existing workflow snapshots and review files remain readable because the change only affects dashboard interpretation and newly generated display diffs. Rollback consists of reverting the dashboard/data/component changes; workflow state, wiki documents, and snapshots are untouched.
