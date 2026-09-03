## 1. Shared Markdown block model

- [x] 1.1 Add a block-model helper module under `src/tui/dash/devenv-ui/` that parses a Markdown document string into ordered top-level blocks, each with `{ startLine, endLine }` (1-based, inclusive) and the block's source text, using the Markdown token structure from `@opentui/core`/`marked` (design D1, D2). Verify with a new focused unit test covering headings, paragraphs, nested lists, tables, block quotes, fenced code blocks, and mixed blank lines, asserting exact `startLine`/`endLine` per block.
- [x] 1.2 Provide helpers on the block model to map a selected block index (and a block index range) to a comment source-line range (`startLine`/`endLine`) per design D4. Verify with unit tests for single-block and multi-block-range mapping, including a block that spans multiple source lines.

## 2. Plan review modal (dashboard-plan-review-comments)

- [x] 2.1 Rewrite `MarkdownViewModal.tsx` to render the whole artifact as block-level Markdown using the block model: each top-level block is a selectable wrapper rendering real Markdown (design D3), replacing the per-line `MarkdownSourceLine` loop. Verify by observable behavior: a list, table, and fenced code block render as formatted blocks (no raw delimiters as primary content) in a `testRender` component test.
- [x] 2.2 Retarget selection, visual-range selection, inline comment threads, `n`/`N` cycling, scroll-into-view, and Esc/close from line indices to block indices, and anchor submitted comments to the selected block's source-line range (single block and block range) per design D4. Verify with a `testRender` test that selecting a block and commenting produces a comment anchored to that block's `startLine`/`endLine` and renders the thread inline.

## 3. Plan panel / OpenSpec artifact view (dashboard-openspec-artifact-view)

- [x] 3.1 Add an opt-in "render as Markdown" flag to `VerdictModal.tsx` and render the artifact content as block-level Markdown when set, leaving the default `code`/plain presentation otherwise (design D5). Verify with a `testRender` test that the artifact path renders formatted Markdown while the verdict/report and Tasks paths render unchanged plain content.
- [x] 3.2 Set the flag only for the OpenSpec artifact callers in `App.tsx` (the OpenSpec panel Enter path and the user-action artifact path), and leave verifier verdict and Tasks-list `setVerdict` callers unchanged. Verify by inspecting the two artifact call sites pass the flag and the verdict/tasks call sites do not (component/behavior test or targeted assertion).

## 4. Wiki review surfaces (knowledge-wiki, home-wiki-view)

- [x] 4.1 Update the wiki review diff in `DiffViewModal.tsx` (`renderMarkdown` path) to render current-side content as block-level Markdown via the block model while preserving the added-green/removed-red/context color semantics and keeping snapshot-only content non-commentable (design D4, wiki-diff risk). Verify with a `testRender` test that current-side multi-line constructs render as formatted blocks, colors are preserved, and a removed/snapshot-only selection cannot create a writable comment anchor.
- [x] 4.2 Ensure the home Wiki note modal (`WikiView.tsx` via the rewritten `MarkdownViewModal`) renders concept content as block-level Markdown and anchors comments to blocks/block ranges (source-line ranges) per `home-wiki-view`. Verify with a `testRender` test that opening a concept renders formatted blocks and a block comment stores the concept id and block source-line range.

## 5. Cleanup and validation

- [x] 5.1 Remove the now-unused per-line `MarkdownSourceLine.tsx` and its `markdownFenceStates` helper (or reduce to what the block model requires), updating all imports (design D6). Verify `rg "MarkdownSourceLine|markdownFenceStates" src/` returns no stale references and the build succeeds.
- [x] 5.2 Run the change-relevant checks and confirm they pass: `bun run lint`, `bun run type-check`, `bun run build`, and the focused tests added/affected by this change (block-model unit tests and the `test/dash` component tests for the plan review, artifact view, and wiki surfaces).
- [x] 5.3 Run `openspec validate "render-markdown-views" --strict` and confirm it passes with zero diagnostics.
