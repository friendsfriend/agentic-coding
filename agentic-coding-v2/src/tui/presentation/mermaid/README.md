# Vendored Mermaid terminal renderer

Vendored from `anomalyco/opencode`, `packages/merman/src`, commit
`5e066ac922ba016dd4a225cd5dea16af829c5b8f` (MIT; see `vendor/LICENSE`).

This is a source copy, not a runtime import of the previous application. Only the
assistant transcript opts into it, through `../renderer.ts` (palette binding) and
`MarkdownViewer`'s opt-in `renderNode`. Transcript data, native authority and every
other Markdown surface are unchanged.

Supported families follow the pinned upstream implementation: flowchart, sequence,
state, timeline, Gantt and Git graph. Unsupported or unparsable syntax, source over
32768 characters or 500 lines, and diagrams that do not fit the canvas fall back to
ordinary readable fenced source. Rendering a diagram never fetches, resolves a link,
invokes a tool or grants approval: it draws supplied text only.

Local changes to the vendored copy:
- Relative imports use `.ts` to satisfy this repository's runtime-target checks.
- `markdown.ts`: bounded source input and actual transcript-width resize layout; see
  inline comments. Streaming recovery/fallback otherwise follows upstream.
- Upstream unit tests are not copied. Their pure parser/layout expectations are
  represented locally by `test/mermaid-vendor.test.ts`; renderable mounting is not
  asserted anywhere, and no terminal acceptance is claimed.

Vendored files are excluded from Biome to preserve upstream diffs, but are included
in the unfiltered type-check and the build. For updates, compare the pinned source
against upstream, retain the license, review local changes, then run the local
Mermaid fixture plus whole-project lint/type-check/build. Do not import OpenCode's
plugin framework.
