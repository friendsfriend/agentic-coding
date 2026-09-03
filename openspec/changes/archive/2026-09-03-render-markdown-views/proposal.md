## Why

The dashboard's Markdown surfaces render one source line at a time: `MarkdownSourceLine` wraps each line as its own isolated one-line Markdown document, and the plan panel (OpenSpec artifact viewer) renders artifacts through `<code filetype="markdown">`, which is syntax-highlighted source, not rendered Markdown. Per-line rendering cannot express block-level constructs (lists, tables, block quotes, and multi-line fenced code blocks span multiple lines), so users see raw Markdown source with delimiter characters instead of formatted output. OpenTUI ships a block-level `<markdown>` renderable that renders proper blocks only when fed a whole document; the current code never uses it that way.

## What Changes

- Render the whole document (not line-by-line) through OpenTUI's block-level Markdown renderable in every surface that displays Markdown: the plan review modal, the plan panel (OpenSpec artifact viewer), the wiki review diff, and the home Wiki view note modal (both plain reading and review commenting).
- **BREAKING (review UX granularity):** For the interactive review surfaces (plan review and wiki review), the selectable/commentable unit changes from a single source line to a top-level Markdown block (heading, paragraph, list, table, block quote, fenced code block). Review comments anchor to the block's source line range (`startLine`/`endLine`) instead of a single line. The persisted comment shape is unchanged; only the granularity of the anchored range coarsens.
- Introduce a shared, testable "block model" helper that parses a Markdown document into top-level blocks, each carrying its source-line range, so plan review, the wiki note modal, and the wiki review diff share one mapping between rendered blocks and source lines.
- Fix the plan panel (OpenSpec artifact viewer, `VerdictModal`) to render Markdown blocks instead of highlighted source, without changing the non-Markdown popups (verifier verdicts and the Tasks list) that reuse the same modal.
- Retire the per-line `MarkdownSourceLine` rendering path once the block model replaces it in every surface.

## Capabilities

### New Capabilities
- `dashboard-openspec-artifact-view`: viewing an OpenSpec artifact (the "plan panel") from the dashboard OpenSpec panel renders the artifact as formatted Markdown, while other popups that share the same modal keep their plain presentation.

### Modified Capabilities
- `dashboard-plan-review-comments`: the plan review modal renders the artifact as block-level Markdown and anchors review comments to top-level blocks (source-line ranges) rather than to a single selectable source line.
- `knowledge-wiki`: the wiki review diff renders concept content as block-level Markdown and anchors current-side review comments to top-level blocks (source-line ranges) rather than to a single current-concept line.
- `home-wiki-view`: opening a concept in the home Wiki view note modal renders its content as block-level Markdown (for plain reading), and review comments anchor to top-level blocks rather than to a single source line.

## Impact

- Code:
  - `agentic-coding/src/tui/dash/devenv-ui/components/MarkdownSourceLine.tsx` (replaced by the block model / removed)
  - `agentic-coding/src/tui/dash/devenv-ui/components/MarkdownViewModal.tsx` (plan review + wiki note modal)
  - `agentic-coding/src/tui/dash/devenv-ui/components/DiffViewModal.tsx` (wiki review diff, `renderMarkdown` path)
  - `agentic-coding/src/tui/dash/ui/VerdictModal.tsx` (plan panel / OpenSpec artifact viewer)
  - `agentic-coding/src/tui/otel/views/WikiView.tsx` (home wiki note modal caller)
  - `agentic-coding/src/tui/dash/App.tsx` (plan review + wiki review wiring, block-range comment anchoring)
  - a new shared Markdown block-model helper module under `agentic-coding/src/tui/dash/devenv-ui/`
- Dependencies: none added; uses the existing `@opentui/core` Markdown renderable.
- Persistence/engine: the review comment payload shape (`line`/`startLine`/`endLine`, `filePath`, `body`) is unchanged; only the anchored range granularity coarsens from per-line to per-block.
