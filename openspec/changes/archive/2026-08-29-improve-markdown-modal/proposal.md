## Why

The plan and wiki review modals currently display Markdown source lines, so headings, emphasis, lists, links, and code blocks are difficult to read. Wiki review also presents the current document alongside an appended textual marker instead of the same clearly color-coded added/removed diff used for developer reviews, making changes hard to verify before approval.

## What Changes

- Render plan-review and wiki-review Markdown artifacts using the existing OpenTUI Markdown rendering capabilities while preserving line navigation, scrolling, and line/range comment anchors.
- Make wiki review present each touched concept as a real snapshot-to-current diff, with selectable lines and the established green added/red removed styling used by developer review.
- Keep snapshot/current boundaries and commentability correct: comments target current concept lines, while snapshot-only lines remain context for review rather than writable anchors.
- Preserve review-list navigation, file/concept counts, postpone/finish actions, and developer-review behavior.
- Add focused dashboard/data/component coverage for rendered Markdown, wiki diff parsing/coloring, line anchors, deleted/new concepts, and the existing review flows.

## Capabilities

### New Capabilities

<!-- None. This change improves existing review capabilities. -->

### Modified Capabilities

- `dashboard-plan-review-comments`: The artifact modal must render Markdown rather than exposing only raw Markdown syntax while retaining selectable line-based review comments.
- `knowledge-wiki`: The wiki review modal must render touched concept changes as a real, color-coded snapshot/current diff with the same review affordances as developer review.

## Impact

- Dashboard review orchestration in `agentic-coding/src/tui/dash/App.tsx`.
- Review presentation components under `agentic-coding/src/tui/dash/devenv-ui/components/`, especially the Markdown and diff modals.
- Wiki snapshot/diff preparation in `agentic-coding/src/tui/dash/data.ts`; the workflow/wiki storage and approval transitions remain unchanged.
- Focused OpenTUI dashboard and wiki-related tests; no new external dependency is expected because OpenTUI already supplies Markdown rendering and the project already owns the developer diff presentation.
