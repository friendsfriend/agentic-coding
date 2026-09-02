## 1. Parity baseline

- [ ] 1.1 Confirm stage B is implemented and archived, so the engine's action list is single-sourced per step. Verify `bun test test/workflow-steps.test.ts` passes and that `core.wiki-approval` resolves from one declaration.
- [ ] 1.2 Capture the current rendered action baseline in `test/dash/userActions.test.tsx`: for every phase (legacy and `core.*`), every definition id, and both `prCreated` values, assert the item list produced by `requiredUserActionFor` equals literal values committed in the test. Verify it passes against unmodified source — this is the drop-detection oracle from design D5.
- [ ] 1.3 Capture the engine's action list for the same combinations from the workflow view, and produce a diff report of engine-vs-dashboard disagreements. Verify the report contains exactly the two known divergences (`wiki-comments` create-pr, and `close-clean`); triage any additional entry as an engine bug or an intended correction before continuing.

## 2. Resolve the two divergences

- [ ] 2.1 Audit `close-clean` per design D2: check the git history of the `data.ts` menu item and confirm no engine action, CLI verb, or effect performs worktree deletion. Record the outcome as dead UI or as a wanted-but-unimplemented capability, and in the latter case record a follow-up change rather than implementing it here. Deliver the finding in the change's design notes.
- [ ] 2.2 Remove the `close-clean` item from the dashboard menu. Verify no dispatch path can produce an action id absent from the view's available actions, with a test asserting every dispatchable item's id is present in the engine action list.
- [ ] 2.3 Delete the dashboard's close-only allowlist (`proposal || wikiOnly`) rather than adding the missing `wiki-comments` entry, per design D3. Verify a completed `wiki-comments` workflow offers no `create-pr` and a completed `openspec-full` workflow still does.

## 3. Derive availability from the engine

- [ ] 3.1 Change `requiredUserActionFor` to accept the view's `WorkflowActionView[]` and derive which items to show from action ids, keeping titles, prompts, labels, and the "Not now" dismiss item as dashboard-owned copy keyed by action id. Verify with the 1.2 baseline — every non-divergence case must be unchanged.
- [ ] 3.2 Render an action whose id has no dashboard copy entry using the engine-supplied `label`, per design D1, so a missing copy entry degrades to a usable button. Verify with a case passing an unknown action id and asserting it renders with the engine label.
- [ ] 3.3 Narrow the legacy phase-derived path to views that carry no `actions` array at all, so a present-but-empty array correctly renders no actions. Verify with two cases: a view with no array falls back, and a view with an empty array renders nothing.
- [ ] 3.4 Confirm `requiredUserActionFor` no longer branches on any definition id for availability. Verify with a scoped `rg` over the function showing no definition-id comparison outside prompt-copy selection.

## 4. Popup selection by action key

- [ ] 4.1 Replace the `App.tsx` step-id checks that decide which review popup opens (lines ~888, 1009, 1105, 1327, 1332, 1337) with a switch on the required action's key, per design D4, with an explicit default that surfaces an unknown key rather than rendering nothing. Verify with `bun test test/dash/userActions.test.tsx`.
- [ ] 4.2 Replace the step-id checks that select the submit path (lines ~1650, 1654) the same way. Verify plan approval, developer review, and wiki approval each submit through their correct path with `bun test test/dash/userActions.test.tsx test/workflow-dashboard.test.ts`.
- [ ] 4.3 Confirm no remaining `data().state.stepId === "core.*"` comparison decides action or popup behavior in `App.tsx`. Verify with a scoped `rg` and record any remaining match that is display-only.

## 5. Tests and change-relevant validation

- [ ] 5.1 Update `test/dash/data.test.ts` and `test/dash/userActions.test.tsx` to pass engine `actions` arrays, asserting the same rendered items as the 1.2 baseline for plan-approval, wiki-approval, developer-review, research, and completed in both PR-capable and close-only forms. Verify all pass.
- [ ] 5.2 Add the two divergence-correction cases: a completed `wiki-comments` workflow offers close without `create-pr`, and no rendered item dispatches `close-clean`. Verify both assert the new behavior explicitly rather than by absence.
- [ ] 5.3 Add a legacy-fallback case covering a view with no `actions` array for each legacy phase name. Verify it renders the pre-engine item set.
- [ ] 5.4 Run the focused suites for the touched surface: `bun test test/dash/userActions.test.tsx test/dash/data.test.ts test/dash/panelNavigation.test.tsx test/workflow-dashboard.test.ts test/workflow-wiki-gate.test.ts` and confirm all pass.
- [ ] 5.5 Run `bun run type-check`, then `bun run format` followed by `bun run lint` with zero diagnostics, then `bun run build`.
- [ ] 5.6 Update `agentic-coding/docs/workflow-architecture.md` to record that the dashboard is an action *client* with no independent availability logic, closing out the sequence's end-state rule. Verify the outstanding-branch list from stages A–C is now empty or lists only explicitly deferred items.
- [ ] 5.7 Run `openspec validate derive-dashboard-actions-from-engine --strict` and confirm it passes.
