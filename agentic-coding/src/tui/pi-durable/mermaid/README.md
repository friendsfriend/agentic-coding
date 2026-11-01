# Pi-durable Mermaid renderer

Vendored from `anomalyco/opencode`, `packages/merman/src`, commit
`5e066ac922ba016dd4a225cd5dea16af829c5b8f` (MIT; see `vendor/LICENSE`).

Source and upstream tests are retained. OpenCode's plugin registration is omitted;
our transcript supplies its own Markdown hook and palette. Vendored files are
excluded from Biome to preserve upstream diffs, but remain type-checked.

Local changes to upstream:
- Relative imports use `.ts` to satisfy repository runtime-target checks.
- `markdown.ts`: bounded source input and actual transcript-width resize layout;
  see inline comments. Streaming recovery/fallback otherwise follows upstream.

Only pi-durable session Markdown opts into this renderer. Transcript data remains
unchanged. Supported families follow the pinned upstream implementation: flowchart,
sequence, state, timeline, Gantt, Git graph. Unsupported syntax falls back to code.

For updates, compare the pinned source against upstream, retain license and tests,
review local changes, then run upstream tests plus transcript integration tests,
whole-project lint/type-check and build. Do not import OpenCode's plugin framework.
