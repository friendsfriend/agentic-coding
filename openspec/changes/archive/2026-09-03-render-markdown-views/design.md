## Context

See proposal.md — Why. Three dashboard surfaces show Markdown source instead of rendered Markdown because they render one source line at a time:

- Plan review: `MarkdownViewModal.tsx` splits the artifact into lines and renders each through `MarkdownSourceLine.tsx`, which wraps a single line as its own one-line Markdown document.
- Wiki review: `DiffViewModal.tsx` (`renderMarkdown` path) uses the same `MarkdownSourceLine` per diff row; the home Wiki note modal (`WikiView.tsx`) reuses `MarkdownViewModal`.
- Plan panel: `VerdictModal.tsx` renders the OpenSpec artifact through `<code filetype="markdown">` — syntax-highlighted source, not rendered Markdown. `VerdictModal` is also reused for verifier verdicts and the Tasks list.

OpenTUI's `<markdown>` renderable (`@opentui/core`) renders proper block-level Markdown only when given a whole document; fed one line it cannot infer multi-line blocks (lists, tables, block quotes, fenced code). It exposes `internalBlockMode: "top-level"`, which keeps each top-level block as its own child renderable.

Comment persistence is line-range based today: comments carry `line`, optional `startLine`/`endLine`, `filePath`, and `body` (`savePlanReview`/`saveWikiReview` in `data.ts`, `WikiReviewComment` in `workflow/wiki.ts`, and the engine payload in `App.tsx`). The developer decision (see proposal — What Changes) is block-level anchoring: keep the line-range payload shape, but derive the range from the selected block(s) instead of a single source line.

## Goals / Non-Goals

**Goals:**
- Render whole-document, block-level Markdown in plan review, plan panel, and both wiki review surfaces.
- Introduce one shared, unit-testable block model that parses a Markdown document into ordered top-level blocks, each with its 1-based source-line range, and reuse it across the interactive surfaces.
- Preserve selection, visual-range selection, inline comment threads, `n`/`N` cycling, and Esc/close behavior — retargeted from lines to blocks.
- Keep the persisted comment payload shape unchanged (`line`/`startLine`/`endLine`).

**Non-Goals:**
- No change to the persisted comment schema, the engine `review-comments` payload contract, or `reviews/*.json` file formats.
- No change to the verifier verdict popup or the Tasks list popup that share `VerdictModal`.
- No new dependency; use the existing `@opentui/core` Markdown renderable.
- No change to how the wiki snapshot diff itself is computed (`loadWikiSnapshotDiff` LCS walk); only how it is rendered and how comments anchor.

## Decisions

**D1: Shared block model helper over per-surface parsing.** Add one module (under `src/tui/dash/devenv-ui/`) that parses a Markdown document string into ordered top-level blocks, each carrying `{ startLine, endLine }` (1-based, inclusive) and the block's source text. All interactive surfaces consume it so selection, comment anchoring, and `n`/`N` cycling operate on a single consistent unit. Alternative considered: let each surface keep its own line loop and only swap the renderable — rejected because it would leave three divergent selection models and cannot express block-spanning selection cleanly.

**D2: Derive blocks from parsed Markdown, not from a hand-rolled line scanner.** Use the same Markdown token structure OpenTUI parses (via `@opentui/core`'s exported parser / `marked` tokens) so the selectable blocks line up with what is rendered, and map each token back to its source-line range from the token's raw text offsets. Alternative considered: reuse the existing `markdownFenceStates` line-state scanner — rejected because it only tracks fenced code and cannot identify lists, tables, or block quotes as single blocks.

**D3: Render each block as a discrete selectable renderable.** Each block is its own `<markdown>` (or the block's rendered renderable) inside a selectable wrapper row, so a block can be highlighted, commented, and scrolled into view independently while still rendering as real Markdown. This keeps the existing wrapper/selection/scroll-into-view machinery in `MarkdownViewModal` and `DiffViewModal` largely intact, retargeted from line indices to block indices. Alternative considered: render the whole document as one `<markdown>` and overlay selection — rejected because a single renderable gives no per-block hit-target or height for selection/scroll.

**D4: Comment anchoring maps block selection to a source-line range.** A single selected block anchors to its `startLine` (with `endLine` when the block spans multiple lines); a visual range of blocks anchors from the first block's `startLine` to the last block's `endLine`. This reuses the existing `onSelectedSourceRangeChange`/`startLine`/`endLine` plumbing without schema change. Snapshot-only (removed) content in the wiki diff remains non-commentable, matching the current-side-only rule.

**D5: Plan panel via an opt-in flag on the shared modal.** `VerdictModal` gains an opt-in "render as Markdown" flag set only for the OpenSpec artifact caller (`activePanel === OPENSPEC_PANEL` and the user-action artifact path). Verifier verdicts and the Tasks list keep the current plain/`code` presentation. Alternative considered: always render Markdown in `VerdictModal` — rejected because verifier reports and the task list are not Markdown documents and would be misrendered.

**D6: Remove `MarkdownSourceLine` after migration.** Once the block model backs all surfaces, the per-line renderer and its `markdownFenceStates` helper are removed (or reduced to what the block model needs) to avoid two parallel rendering paths. This is the retirement noted in the proposal.

## Risks / Trade-offs

- **Comment granularity coarsens from per-line to per-block.** → Accepted per the developer decision; block ranges still uniquely locate feedback, and a paragraph/list is a natural review unit. Documented in the modified specs.
- **Source-line range mapping drift** (a token's reported raw text not aligning with its true source lines, e.g. around blank lines or trailing whitespace). → Cover the block-model mapping with focused unit tests over representative documents (headings, nested lists, tables, block quotes, fenced code, mixed blank lines) asserting exact `startLine`/`endLine`.
- **Wiki diff rendering complexity**: the diff has added/removed/context rows, and block-level Markdown rendering must still color added vs removed vs context and keep only current-side content commentable. → Render current-side content as block-level Markdown for anchoring/commenting while preserving the established add/remove/context color semantics; keep snapshot-only content non-commentable as today. Detailed row/block reconciliation is an implementation task, constrained by the `knowledge-wiki` scenarios.
- **Selection/scroll behavior regressions** (scroll-into-view, wrap-around, visual range) when indices move from lines to blocks. → Keep the existing wrapper/scroll machinery and add focused tests for block navigation and range selection where the components are testable.
- **Shared-modal blast radius** in `VerdictModal`. → The opt-in flag (D5) confines Markdown rendering to the artifact caller; scenarios in `dashboard-openspec-artifact-view` assert verdict and Tasks popups are unchanged.

## Open Questions

None that change the specs, approach, or task breakdown. The exact wiki-diff block/row reconciliation is left to implementation within the `knowledge-wiki` scenarios and D4/the third risk above.
