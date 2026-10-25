# Transcript tool UI

Tools use the same renderer standalone and inside codemode. Everything starts
expanded. Clicking a card or section folds it independently, without disclosure
arrows. Selection drags do not fold a card. Content wraps and scrolls with the
transcript; cards do not create nested scroll boxes.

## Presentation layers

- `src/tui/dash/ui/tool-views.ts`: native file, shell, codemode, question and
  judgment projections. Codemode carries actual nested calls, not a parallel
  text approximation of their views.
- `custom-tool-views.ts`: registered custom tool families and the unknown-tool
  fallback. `customToolNames` is checked against direct host tool registrations.
- `tool-content.ts`: pure, loss-preserving content projection, defensive
  credential-field redaction, JSON/source/Markdown detection, tables and status
  rows. Backend redaction remains authoritative for secret values in prose.
- `ToolTable.tsx`: responsive tables; narrow panes stack labeled cells instead
  of clipping values or adding horizontal scrolling.
- `AgentSessionView.tsx`: shared card framing, independent section hover and
  folding, and native code/Markdown/table rendering.

Search results group file/line matches with muted line-number gutters and literal
pattern highlighting. Environment actions share bash output rendering. HTTP
separates request/headers/body; SQL separates highlighted source/options/results.
Browser observations preserve refs and page identity; scripts separate source,
options, output and return values. Trace trees preserve span hierarchy when
provided; logs and request lists use structured rows/tables. Workflow, stage,
event, evidence and investigation results preserve all returned fields, including
unknown fields added by later servers. Reports render as Markdown when provided.

Questions show their question once and separate context from choices/answers.
Judgments separate each verdict, confidence, distribution and criteria; warnings
and metadata are separate. No additional UI row limit hides expanded content.
Upstream truncation diagnostics remain visible.

## Structured data and live output

Host adapters attach bounded, already-redacted objects as `result.details.view`
alongside their existing model-facing text. Historical results fall back to
parsing valid JSON or showing retained text; the UI does not infer structured
fields by scraping formatted prose. Unknown arguments and result fields remain
available, without repeating the old serialized request line beneath the header.

Build/test tools request `application/x-ndjson` on the existing owner-scoped
environment endpoint. Older JSON-only servers still work. The action runner
opts into real stdout/stderr streaming only for observed agent actions; ordinary
legacy command runners retain their existing buffered behavior. The stream:

- coalesces progress snapshots for slow consumers, retaining bounded queue size;
- redacts before publishing, withholding suffixes that could become a secret
  across output chunks (including overlapping secrets);
- propagates cancellation to the action;
- returns a final result without appending its log twice;
- keeps bounded action logs valid JSON, preserving status/exit code/truncation.

The host publishes snapshots through the existing live `details` document. The
TUI performs no network I/O or polling. Snapshot-only tools remain snapshot-only;
in particular, a browser script's result does not pretend to stream when its API
only supplies a final response.

## Adding a tool

Register its family in `custom-tool-views.ts` and reuse existing content
primitives. Preserve unfamiliar fields and diagnostics, distinguish transport
failure from domain outcomes, and never render credential values from arguments.
Use stable section IDs so folds persist while output arrives. Add projection
tests and renderer-boundary tests for narrow/wide layouts, independent hover,
folding and transcript-owned scrolling.

Run `bun run test test/dash test/agent-action-progress.test.ts` plus relevant host
and route tests, then the whole-project lint/type-check gates.
