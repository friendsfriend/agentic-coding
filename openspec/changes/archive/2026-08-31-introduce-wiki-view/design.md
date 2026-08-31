## Context

The home shell is implemented by `src/tui/otel/app/App.tsx`; it owns the top-level tabs, global key routing, and status bar, while the Workflows tab delegates to `src/tui/dash/Home.tsx`. The centralized OKF wiki already has read APIs (`listConcepts`, `readConcept`, and `wikiRoot`) in `src/workflow/wiki.ts`. The dashboard also contains line-oriented Markdown and review-comment UI that can be reused, including `MarkdownViewModal`, `MarkdownSourceLine`, and the existing local comment serialization used by wiki approval.

The existing `wiki-only` workflow is deliberately repository-backed: it uses a repository checkout as evidence and is exposed by the CLI and New Workflow modal. The requested home-view review has different semantics. It must be started only by the UI, must operate on the centralized wiki without a source repository, must carry comments anchored to current wiki lines, and must launch a wiki agent before running wiki verification.

## Goals / Non-Goals

**Goals:**

- Add a home-mode Wiki tab with a navigable hierarchical concept tree and Markdown note inspection.
- Keep a review session alive while navigating between notes, with comments stored only in memory until `f` is submitted.
- Start a dedicated UI-only wiki comment workflow from the submitted comments, using the centralized wiki root as the agent's working context and no repository association.
- Reuse the existing workflow lifecycle, agent adapters, authenticated wiki writer, assignment rendering, and engine-owned `wiki.verify` effect where possible.
- Preserve the repository-backed `wiki-only` workflow and all existing CLI/new-workflow-modal behavior.

**Non-Goals:**

- Changing the OKF document format, wiki root precedence, concept namespaces, or CLI read/write operations.
- Editing wiki notes directly from the home view; only the spawned wiki agent writes notes.
- Adding a second persistent comment store or retaining unfinished comments after the TUI process/review session ends.
- Making the new UI-only workflow selectable through the CLI or New Workflow modal.
- Running repository code implementation, OpenSpec planning, or repository verification as part of the comment workflow.

## Decisions

### 1. Add a dedicated home-shell Wiki tab and keep review state above the tab component

Add a `wiki` tab to the shell's tab union, tab list, dynamic tab navigation, render branch, and status-bar keybinds. It is shown in home mode and remains available when `--traces-only` hides only the observability tabs. The Wiki view reads the centralized bundle on initial mount and on explicit refresh, and exposes bounded loading, empty, malformed-document, and read-error states without crashing the shell.

The tree model is derived from `listConcepts()` and groups concept IDs by path components. Directory rows expand/collapse; concept rows open the note viewer on Enter. Selection and expansion are kept in the Wiki view, while the cross-file comment collection and workflow-submission state are owned by the shell-level Wiki tab state (or a dedicated store mounted for the shell lifetime). This prevents conditional tab rendering or closing a note modal from dropping comments.

Alternative considered: adding a repository-local wiki browser to `dash/Home.tsx`. Rejected because the bundle is centralized and the requested tab is a home-shell concern, not a workflow-specific dashboard concern.

### 2. Reuse the existing Markdown line renderer but adapt comments to a wiki-review model

The note modal will use the existing Markdown rendering and line navigation conventions. It will expose current source line numbers, optional visual line ranges, `c` comment entry, `n/N` note navigation, and `f` finish. A comment record contains the concept ID, current 1-based line, optional start/end range, and body. The in-memory collection is keyed by concept ID so several comments on one note and comments across notes are preserved.

The implementation should either extend `MarkdownViewModal` with a small local-comment adapter or extract its line/comment presentation into a reusable component; it must not duplicate Markdown parsing, fence handling, scrolling, or OpenTUI styling. Existing developer-review and wiki-approval consumers must retain their current behavior. Escape closes the note without submitting comments, and switching tabs does not submit or clear them. `f` with no comments is a no-op with a user-visible notification; a non-empty submission freezes the review input before launching the workflow.

Alternative considered: converting local comments into GitLab `Discussion` objects. Rejected because there is no repository, commit, or remote discussion and the new comments need only be workflow assignment input.

### 3. Introduce a repository-independent UI-only wiki workflow target

Add a distinct internal workflow definition (for example `wiki-comment-review`) rather than repurposing `wiki-only`. It contains the existing `core.wiki` agent step and an engine-owned wiki verification transition, with bounded retry/failure handling and a terminal completion/close path. It is not included in CLI workflow choices or New Workflow modal choices. The UI creates a unique change/session ID, serializes the submitted comments into workflow task/step context, and starts this definition through an in-process dashboard helper.

Because the current engine opens a SQLite store through `canonicalRepository(repo)`, add an explicit non-repository workflow target/store path rooted in the resolved centralized wiki configuration. The target must carry a work context of the wiki root but no source repository, branch, checkout, or Git baseline. Persisting state under an application-owned workflow database beside the centralized bundle is preferred over a sentinel Git repository; all status/dispatch/effect calls for this target must use the same target locator. Existing repository-targeted workflows remain on the current database path and validation guards.

The agent assignment must include the review comments as untrusted developer-provided input, identify the centralized wiki scope, and preserve the authenticated `core.wiki` writer requirements. The workflow must not accept a source-repository edit or OpenSpec artifact path as a substitute for addressing the comments.

Alternative considered: start the existing repository-backed `wiki-only` definition against a fake repository. Rejected because it violates the no-repository requirement, introduces misleading source isolation semantics, and would expose the workflow through unsupported user entry points.

### 4. Launch the wiki agent in a wiki-root workspace and verify after completion

Extend the effect runner's target handling so the UI-only target can create/reuse a Herdr workspace/tab with `cwd` set to the centralized wiki root, without attempting Git branch/worktree operations. Agent launch, prompt, observation, stop, assignment assets, and telemetry continue through the existing adapters and lifecycle. The UI refreshes the home list/notification state after start and while the workflow progresses, but does not block on agent completion.

On successful wiki-agent handoff, transition to the engine-owned `wiki.verify` effect. Verification must operate against the pinned wiki root and the concepts touched by this review/workflow, use the configured reviewer identity with the existing fallback rules, and reject content changes after the approved digest point. No repository commit, delivery, pull request, or repository cleanup effect is allowed. Comments/agent retry paths remain bounded and reuse the workflow's active lifecycle rather than silently creating a second review workflow.

Alternative considered: invoke `agentic-coding workflow wiki` or `wiki.verify` as child processes from the TUI. Rejected because dashboard actions already use the in-process engine and subprocesses would lose revision/idempotency guarantees and UI refresh integration.

### 5. Keep existing wiki-only compatibility explicit

Register and validate the new target/definition alongside existing definitions, but leave the current `wiki-only` definition, its repository requirement, CLI start validation, New Workflow modal option, source-isolation baseline, and approval semantics unchanged. Generated embedded agent assets must be regenerated with the normal build process whenever pinned definitions/instructions change; `embedded.generated.ts` is not hand-edited.

## Risks / Trade-offs

- [Global workflow persistence is a new storage path] → Centralize target resolution in one helper, use the same SQLite schema and revision checks, and add migration/cleanup tests for restart and concurrent dispatch behavior.
- [A wiki-root workspace may not be accepted by every Herdr workspace operation] → Keep workspace creation in a dedicated target-aware effect path, validate the returned workspace/tab identity, and surface a bounded launch error without mutating wiki content.
- [Line comments can become stale while an agent or another process edits a note] → Pass concept IDs and current line/range anchors to the agent, snapshot/digest touched concepts before verification, and fail verification clearly when the reviewed content changed unexpectedly.
- [Adding a tab can change numeric/cyclic navigation] → Derive all tab switching and help labels from one ordered tab-ID list and test both home and `--traces-only` tab sets.
- [Existing Markdown review consumers could regress if generalized too broadly] → Preserve their props/behavior through an adapter or focused extraction and run their existing component tests plus new Wiki-view tests.
- [Large centralized bundles may make tree rebuilds expensive] → Load once per refresh, use stable sorted IDs, and defer full note content reads until a concept is opened.

## Migration Plan

1. Add the new capability specs and implement the target-aware workflow/data model behind focused unit tests.
2. Add the Wiki tab and local review state, then wire `f` to the in-process workflow starter and refresh/notification path.
3. Register the new definition and regenerate embedded assets; verify that existing CLI and New Workflow modal choices do not include it.
4. Roll back by removing the UI trigger/definition and leaving the centralized wiki documents untouched; persisted unfinished UI-only sessions can be ignored or cleaned by the target-store maintenance path without affecting repository workflows.

## Open Questions

- None blocking after the decision to start a distinct UI-only workflow with the centralized wiki root as its context and no source repository.
