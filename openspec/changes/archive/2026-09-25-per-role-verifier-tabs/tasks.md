# Tasks

## 1. Step behavior layout group

- [x] 1.1 In `agentic-coding/src/workflow/steps/types.ts`, add an optional `groupByRole?: boolean` to `StepBehavior` and extend the `paneGroup` doc comment to explain that `groupByRole` resolves the layout group to the run's role while `roundScoped` still governs agent naming. Verify with `bun run type-check`.
- [x] 1.2 In `agentic-coding/src/workflow/steps/verification.ts`, set `groupByRole: true` on `core.verification` while keeping `roundScoped: true` and `paneGroup: "verification"`, and update its comment to say verifiers name round-scoped but group per role; leave `core.triage` unchanged. Verify with `bun run type-check`; the observable per-role allocation is covered by the tests in group 3.

## 2. Pane allocation resolves per-role groups

- [x] 2.1 In `agentic-coding/src/workflow/cli/pane.ts`, change `paneGroup(behavior)` to `paneGroup(behavior, role)` returning `role` when `behavior.groupByRole === true`, and pass `run.role` at the allocation call site and each candidate's `item.role` in the sibling filter; update the function and factory comments so the per-role grouping is documented. Verify with a focused test that a `core.verification` launch never calls `pane split` and creates a tab labeled `<glyph> <role>`.
- [x] 2.2 In `agentic-coding/src/workflow/tab-status.ts`, update the module comment that says grouped roles (verification) share one tab to describe per-role verifier tabs while a genuinely shared tab still aggregates. Verify with `bun run type-check` (comment-only; no behavior change).

## 3. Focused tests

- [x] 3.1 In `agentic-coding/test/workflow-cli.test.ts`, update the verifier/triage tab allocation cases (`~lines 595-950`) so a verifier launch creates a per-role tab labeled `○ <role>` instead of `○ verification`, and the triage case still creates `○ triage`; keep the direct `verificationPosition` unit test. Verify with `bun test test/workflow-cli.test.ts`.
- [x] 3.2 Add a case launching two different verifier roles and asserting two separate `tab create` calls with distinct role labels and no `pane split` call between them. Verify with `bun test test/workflow-cli.test.ts`.
- [x] 3.3 Add a case where a verifier role's canonical agent is already live on re-entry and assert the existing pane/tab is reused with no `tab create`, covering cross-round and fix-loop stability. Verify with `bun test test/workflow-cli.test.ts`.
- [x] 3.4 Keep the generic grid-split coverage by driving `paneForRunFactory` with a synthetic step behavior that uses a shared constant `paneGroup` (no `groupByRole`) plus multiple roles, asserting the split path still anchors on the live sibling; adjust or replace the existing grid cases accordingly. Verify with `bun test test/workflow-cli.test.ts`.

## 4. Docs

- [x] 4.1 In `agentic-coding/docs/workflow-architecture.md`, update the `roundScoped` / `paneGroup` note to describe `groupByRole` and that verifier roles now own per-role tabs while triage stays its own group. Verify the paragraph names `groupByRole` and still lists `roundScoped` as naming.

## 5. Change checks

- [x] 5.1 From `agentic-coding/`, run `bun run type-check` and `bun run lint` (both clean). The workflow test verifier owns the complete repository suite; do not run it here.
- [x] 5.2 From `agentic-coding/`, run the focused suite `bun test test/workflow-cli.test.ts` and confirm the updated allocation cases pass.
