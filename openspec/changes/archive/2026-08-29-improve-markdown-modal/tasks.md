## 1. Render Markdown while retaining source-line review anchors

- [x] 1.1 Add the shared source-line Markdown rendering adapter in `agentic-coding/src/tui/dash/devenv-ui/components/` using OpenTUI's native Markdown renderable and syntax style, preserving blank lines, fenced-code state, readable fallback output, and the diff/document color tone; verify it renders headings, inline emphasis/links/code, lists, block quotes, rules, and fenced code without requiring a new dependency.
- [x] 1.2 Update `MarkdownViewModal.tsx` to use the adapter inside stable selectable source-line wrappers, preserving `line-N` scrolling, mouse/keyboard selection, visual ranges, inline discussions, comment input, comment cycling, and file navigation; verify source-line and range comments still persist/render at the intended source lines in focused OpenTUI modal tests.

## 2. Build and present wiki changes as real diffs

- [x] 2.1 Refactor `agentic-coding/src/tui/dash/data.ts` so `loadWikiSnapshotDiff` emits a valid unified diff with accurate hunk metadata and old/new line numbering for modified, new, deleted, and empty concepts, while retaining the existing LCS comparison and snapshot immutability; verify the output and line counts with focused data tests.
- [x] 2.2 Extend `DiffViewModal.tsx` with the smallest explicit current-side-only mapping/rendering support needed by wiki review, including Markdown content presentation, current-line commentability, removed-line rejection, and the existing green/red/context colors without changing developer finding behavior; verify unified and split wiki rows, selection, comments, and color-coded additions/removals with focused component tests.

## 3. Wire both review flows through the dashboard

- [x] 3.1 Update `agentic-coding/src/tui/dash/App.tsx` so plan artifacts use the rendered Markdown modal and wiki concepts use the diff modal with new/deleted flags, current-side comment restrictions, navigation, and review discussions; remove the sentinel-specific routing/guards while preserving list, postpone, finish, and developer-review behavior; verify the dashboard opens and returns from each modal without dispatching unintended actions.
- [x] 3.2 Extend `agentic-coding/test/dash/userActions.test.tsx` and related focused dashboard tests with rich Markdown assertions and a wiki approval fixture covering the touched-concept list, modified/new/deleted diffs, green/red output, current-line comments, snapshot-only rejection, return-to-list, and finish actions; verify with the targeted OpenTUI test files.

## 4. Validate the delivered planning and focused behavior

- [x] 4.1 Run the focused dashboard/data/wiki tests for the changed behavior plus `bun run type-check` and Biome checks for changed source files, resolving diagnostics without adding a repository-wide test requirement.
- [x] 4.2 Run `openspec validate improve-markdown-modal --strict` and verify the validated proposal, both capability delta specs, design, and task files are present and identify their implementation/test evidence.
