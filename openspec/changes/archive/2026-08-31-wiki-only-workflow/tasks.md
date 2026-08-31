## 1. Workflow definition and source-isolation contract

- [x] 1.1 Extend the built-in registry in `agentic-coding/src/workflow/definitions.ts` with the versioned `wiki-only` manifest, reusing `core.wiki`, `core.wiki-approval`, `core.completed`, and `core.closed`; define bounded documentation/review loops, the approval `wiki.verify` effect, and no archive/delivery/PR edges.
- [x] 1.2 Add the wiki-only source-baseline metadata and deterministic Git content fingerprinting in the workflow contracts/runtime, preserving pre-existing dirty tracked, staged, and untracked content while excluding only engine bookkeeping and centralized wiki output.
- [x] 1.3 Update runtime start/setup and handoff guards so `wiki-only` requires a valid repository, checkout mode, and named current branch, uses `sameCheckout: true`, skips OpenSpec/clean-tree/remote requirements, and rejects a persisted source-content change before successful wiki completion.
- [x] 1.4 Update the wiki documentation assignment/instruction assets to state the repository-evidence-only permissions, allowed centralized wiki writes, supported documentation use cases, and source-file prohibition; regenerate embedded assets through the existing build process rather than editing generated output.

## 2. CLI, routing, and dashboard exposure

- [x] 2.1 Add `wiki-only` to CLI workflow validation/help, start argument conversion, task requirements, policy-version lookup, and role routing; ensure it resolves only the `wiki` role and emits repository-required checkout semantics.
- [x] 2.2 Update dashboard start data and `NewWorkflowModal` workflow choices, labels, task-field behavior, and repository/mode guidance for `wiki-only`; ensure implementation, archive, delivery, and pull-request actions are not offered for its states.
- [x] 2.3 Update user-facing workflow documentation, including the workflow list and repository-evidence-only behavior, without documenting any repository code mutation as part of a wiki-only run.

## 3. Focused verification

- [x] 3.1 Extend registry and end-to-end workflow tests to assert registration/pinning, the exact wiki-only graph, bounded retries, approval promotion, comments returning to documentation, explicit close, and absence of code-changing/delivery effects.
- [x] 3.2 Add runtime/CLI tests for repository-required startup, checkout-only/same-checkout behavior, dirty-tree acceptance, OpenSpec-free startup, non-empty task propagation, branch/worktree guard failures, and source-baseline mutation rejection while preserving pre-existing changes.
- [x] 3.3 Add dashboard and assignment tests for the new workflow choice, task/context rendering, wiki-role routing, and absence of implementation/delivery actions; add documentation-scope tests for the updated instruction asset.
- [x] 3.4 Run the focused affected workflow, CLI, dashboard, and asset tests; then run `bun run type-check`, `bun run build`, and `bun run lint` from `agentic-coding/`. Do not prescribe or run the complete repository test suite in the worker task; the workflow-owned test verifier owns that check.
