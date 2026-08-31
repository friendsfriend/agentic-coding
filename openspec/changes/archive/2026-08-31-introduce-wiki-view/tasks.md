## 1. Repository-independent wiki workflow foundation

- [x] 1.1 Add a typed wiki-review comment payload and an explicit non-repository workflow target/store locator, including an application-owned SQLite path rooted beside the resolved centralized wiki bundle and backward-compatible repository-target handling.
- [x] 1.2 Extend workflow runtime contracts and persistence operations so the UI-only target can start, locate, dispatch, and refresh a revision-bound workflow without canonicalizing a Git repository, branch, worktree, OpenSpec project, or source baseline.
- [x] 1.3 Register the internal `wiki-comment-review` definition using the existing `core.wiki` agent step, bounded retry paths, an engine-owned wiki verification transition after agent completion, and a terminal lifecycle; prove that code-changing, delivery, pull-request, and repository-cleanup paths are unreachable.
- [x] 1.4 Add the in-process start/status helper used by the home UI. It SHALL generate a unique session/change identifier, validate non-empty line-anchored comments, serialize comments as untrusted workflow context, and prevent duplicate submission; do not add the definition to CLI or New Workflow modal choices.
- [x] 1.5 Extend assignment rendering and target-aware effect execution so the wiki agent runs through the existing authenticated `wiki` role in a Herdr workspace/tab rooted at the centralized wiki directory, can write only centralized wiki drafts, and does not receive repository-editing capabilities.
- [x] 1.6 Trigger the engine-owned `wiki.verify` effect after successful agent handoff, pin the centralized wiki root and touched-concept digests, support configured reviewer fallback without Git, and preserve bounded diagnostics for concurrent wiki changes and retry exhaustion.

## 2. Wiki tree and Markdown review UI

- [x] 2.1 Implement a pure wiki tree model from `listConcepts()` that groups nested concept IDs into sorted directory/concept rows, excludes reserved files, supports expansion/selection, and exposes loading, empty, missing-note, and read-error states without uncaught render failures.
- [x] 2.2 Add focused wiki-view data helpers for on-demand `readConcept()` loading and explicit refresh, preserving the centralized `wikiRoot` resolution and avoiding eager body reads while building the tree.
- [x] 2.3 Reuse or narrowly generalize `MarkdownViewModal`/`MarkdownSourceLine` to display wiki notes with source line numbers, line/range selection, inline local comments, and existing Markdown styling without regressing developer-review or wiki-approval consumers.
- [x] 2.4 Implement the Wiki tab component's keyboard/mouse behavior: Enter opens directories or notes, `j/k` navigates, `c` creates a non-empty line/range comment, `n/N` navigates notes, Escape returns without submission, and `f` submits only a non-empty review.
- [x] 2.5 Keep the review comment collection and submission guard at shell lifetime (or in a dedicated store), so comments survive note close, note changes, tab switches, and multiple files while remaining memory-only until `f`; show notifications for blank comments, empty finish, submission, and failure.

## 3. Home shell integration

- [x] 3.1 Add the Wiki tab to the home shell's tab union, ordered tab IDs, cycling/direct selection, render branch, and context-sensitive status-bar/help bindings; keep it available when `--traces-only` hides observability tabs and keep numeric/cyclic navigation derived from one list.
- [x] 3.2 Wire Wiki-tab finish to the in-process workflow start helper, refresh/notification handling, and active workflow status display without blocking the TUI; refresh from canonical workflow state rather than inferring success from an agent pane.
- [x] 3.3 Keep the existing repository-backed `wiki-only` CLI and New Workflow modal paths unchanged, and verify the internal workflow is absent from public workflow help and selector choices.

## 4. Focused verification and generated artifacts

- [x] 4.1 Add unit tests for tree construction, deterministic sorting, reserved-file exclusion, on-demand note loading, line/range comment anchoring, multi-note comment retention, blank-comment rejection, and memory-only cancellation behavior.
- [x] 4.2 Add focused TUI tests for Wiki tab visibility/order, `--traces-only` behavior, tab navigation/help, directory and note selection, Markdown comment controls, finish guard, and submission feedback.
- [x] 4.3 Add focused workflow tests for non-repository startup/storage, assignment comment context and permissions, workspace cwd, UI-only exposure boundary, bounded retries, verification scheduling/digest checks, and preservation of repository-backed `wiki-only` behavior.
- [x] 4.4 Regenerate embedded workflow assets with `bun run build` after definition/instruction changes, then run the focused affected test files plus `bun run type-check` and `bun run lint`; do not hand-edit `src/workflow/embedded.generated.ts` or prescribe the complete repository suite as a worker task.
- [x] 4.5 Validate the completed implementation against the two new capability specs, including a manual home-mode smoke check that opens a nested note, adds comments across notes, finishes with `f`, observes the wiki agent start, and confirms verification feedback.
