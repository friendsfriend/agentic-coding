## Context

The dashboard already has a `busy` signal and a reusable `ProgressModal`, but `ProgressModal` is currently hard-coded to the workflow-creation title and is only mounted by `NewWorkflowModal`. `NewWorkflowModal.submit()` sets `creating` and immediately invokes `onComplete`; workflow setup can then perform synchronous git/config work before OpenTUI paints the new state. The dashboard review finish handlers have the same timing problem for fast/demo paths and currently expose only a status-bar message while saving or dispatching.

The review popup is intentionally kept open until its existing `finally` cleanup. Credential requests can also be serviced while the dashboard is busy, so a progress overlay must not replace or interfere with the credential modal. The requested scope is limited to workflow creation and finishing the plan/developer review gates.

## Goals / Non-Goals

**Goals:**

- Paint the creation progress modal before workflow completion work begins.
- Show a title/message-specific progress overlay while either review finish operation is saving or dispatching, including the demo path.
- Keep progress visible while the review popup remains open, then clear it in the existing cleanup path.
- Preserve the existing status-bar messages, busy key suppression, credential handling, and workflow outcomes.
- Verify the visible intermediate and completed states with focused TUI tests.

**Non-Goals:**

- No changes to workflow engine actions, review persistence formats, APIs, or dependencies.
- No loading overlay for reject-plan, repair preview, or unrelated busy-gated operations.
- No replacement of the status bar or redesign of modal stacking.

## Decisions

1. **Reuse `ProgressModal` and make its title configurable.** Add an optional title prop defaulting to `Creating workflow`, preserving existing creation output while allowing the dashboard to render a `Finishing review` title. The centered progress body and existing `GenericModal` styling remain unchanged. A second loading component or a new global loading framework would duplicate established UI behavior without adding value.

2. **Use a dedicated review-finishing signal in addition to the existing busy guard.** Set `reviewFinishing` and the operation-specific message when a valid review finish begins, and clear the signal in `finally`. Continue using `busy` to reject concurrent actions. The overlay is therefore scoped to the two requested review operations instead of appearing for every busy action (such as repairs), and it does not compete with the credential modal. The status message remains alongside the overlay because it is existing feedback and can still communicate the eventual result/error.

3. **Yield one macrotask after entering each progress state.** In `NewWorkflowModal.submit()` set `creating(true)` and await a zero-delay timer before invoking `onComplete`. In both dashboard finish handlers set `busy(true)`, set the review-finishing state/message, and await the same kind of event-loop yield before collecting/saving/dispatching. A macrotask yield gives Solid/OpenTUI an opportunity to render before synchronous work; a microtask is insufficient for the blocking workflow setup. A double yield or renderer-specific flush is rejected unless tests show the single macrotask does not paint reliably, because it adds latency without evidence.

4. **Mount the review overlay after the review modal branches.** Render `ProgressModal` while `reviewFinishing()` is true after the plan/developer review views, so it visually stacks above the still-open review popup. Existing `finally` cleanup closes the review and resets `busy`; it also resets review-finishing state, preventing stale progress after success or errors. No additional key handling is needed because `busy()` already swallows dashboard actions.

5. **Test the intermediate frame with deferred completion.** Add a NewWorkflowModal test whose completion promise is controlled and assert that the creation modal is visible before resolving it. Extend dashboard review interaction coverage with controlled/deferred finish work (or an observable intermediate frame) for both plan and developer review, then assert the overlay disappears and the popup closes after resolution. This avoids relying on a timing-sensitive flash in the synchronous demo path alone.

### Alternatives rejected

- Rendering `ProgressModal` for every `busy()` operation was rejected because busy also covers unrelated actions and credential delivery; it would broaden the requested UX change and could obscure a higher-priority credential popup.
- A separate `reviewFinishing` component/system was rejected in favor of the existing modal to keep appearance and lifecycle behavior consistent.
- Only updating the status bar was rejected because the status bar is not sufficient immediate feedback when modal content is active.

## Risks / Trade-offs

- **[Risk]** A zero-delay timer may not correspond to an actual renderer frame on every OpenTUI test/runtime schedule. → **Mitigation:** assert the intermediate state with TUI tests; only add another yield or an explicit renderer flush if the focused tests demonstrate it is needed.
- **[Risk]** The review overlay changes the modal stack while the review popup is still open. → **Mitigation:** mount it after the review branches, preserve existing keymap state, and verify both overlay visibility and cleanup in interaction tests.
- **[Risk]** A new yield delays save/dispatch by one event-loop turn and leaves a small interval before the operation starts. → **Mitigation:** existing `creating`/`busy` guards absorb repeated keypresses, and the delay is bounded to one macrotask.
- **[Risk]** Credential requests can occur during busy operations. → **Mitigation:** leave credential modal rendering and its ungated delivery path unchanged; scope the new review overlay rather than deriving it from all busy state.

## Migration Plan

No migration or deployment sequencing is required. Implement the TUI and tests together. Rollback consists of reverting the component/state/test changes; no persisted data or workflow state needs conversion.

## Open Questions

None. Repository inspection confirms the existing developer-review and plan-review popup specifications are the requirements that need deltas, while other busy-gated operations are outside this task's scope.
