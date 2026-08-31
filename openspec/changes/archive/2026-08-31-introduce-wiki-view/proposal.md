## Why

The main agentic-coding home view currently exposes workflow and observability information but offers no way to browse or review the centralized knowledge wiki. Developers must leave the TUI to inspect Markdown notes and have no convenient way to collect line-specific feedback across multiple notes for a wiki agent to address.

## What Changes

- Add a Wiki tab to the home shell alongside Workflows and the existing observability tabs.
- Render the centralized wiki as a navigable file tree, including nested concept paths and an empty/error state when the bundle cannot be read.
- Open a selected wiki note in the existing Markdown viewer, with line selection and temporary line/range comments across multiple notes.
- Finish a wiki review with `f` to submit the collected comments and start a dedicated UI-only wiki documentation workflow.
- Run the wiki agent against the centralized wiki without associating the review workflow with a source repository, then trigger wiki verification after the agent completes.
- Keep the existing repository-backed `wiki-only` workflow and its new-workflow-modal/CLI entry points unchanged; the new comment-review workflow is UI-triggered only.

## Capabilities

### New Capabilities

- `home-wiki-view`: Browse the centralized wiki in a home-shell tab, inspect Markdown notes, and collect cross-note line comments in memory until review completion.
- `wiki-comment-workflow`: Start and drive a repository-independent, UI-only wiki-agent workflow from finished home-view comments through wiki verification.

### Modified Capabilities

- None.

## Impact

- TUI shell tab definitions, navigation, status-bar help, and home-mode rendering in `agentic-coding/src/tui/otel/app/App.tsx`.
- New wiki tree/review UI components and focused UI tests, reusing the existing centralized wiki reader and Markdown rendering/comment interaction patterns.
- Workflow start/runtime contracts, persistence location, assignment context, effect execution, and completion handling for a repository-independent UI-only wiki comment workflow.
- Wiki data access and review input plumbing in `agentic-coding/src/tui/dash/data.ts` or a focused wiki UI data module; no changes to the centralized OKF document format or existing CLI operations.
- Workflow definitions/registration and generated agent assets as required by the new workflow step; generated artifacts must be regenerated rather than hand-edited.
- Focused tests for tree rendering/navigation, comment lifetime and anchoring, tab integration, workflow launch context, comment handoff, and post-agent wiki verification. The workflow-owned test verifier will run the complete configured repository suite separately.
