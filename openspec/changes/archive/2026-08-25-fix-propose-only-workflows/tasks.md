## 1. Proposal workflow graph

- [x] 1.1 Update `agentic-coding/src/workflow/definitions.ts` so `standard-propose` routes validated planning through `core.plan-approval`, `core.completed`, and `core.closed`, retaining bounded planning retries and review rejection/comments loops.
- [x] 1.2 Update the `fusion-propose` manifest in `agentic-coding/src/workflow/definitions.ts` so consolidation routes through plan approval, completion, and explicit close while retaining planner/consolidator retry bounds and excluding downstream execution steps.
- [x] 1.3 Preserve the shared `core.completed` registry contract required for full workflows while ensuring proposal manifests have no reachable pull-request action/effect path and still pass graph validation.

## 2. Runtime lifecycle and effects

- [x] 2.1 Restrict proposal `core.completed` actions in `agentic-coding/src/workflow/runtime.ts` to explicit close, rejecting direct proposal pull-request creation without enqueueing an effect.
- [x] 2.2 Verify the existing terminal entry/effect sequencing schedules no `workspace.close` while a proposal is in plan approval or completed, and schedules workspace close followed by cleanup only after the close transition.
- [x] 2.3 Add runtime coverage in `agentic-coding/test/workflow-runtime.test.ts` for standard proposal plan completion, approval, explicit close, and rejection/comments review-fix context.
- [x] 2.4 Add lifecycle/effect coverage in `agentic-coding/test/workflow-effects.test.ts` and/or `agentic-coding/test/workflow-plan-fusion.test.ts` for standard and fusion proposals: workspace remains open through approval/completion, no implementation/verification/archive/delivery/PR effects occur, and close/cleanup appear only after explicit close.

## 3. Registry and unchanged workflow regressions

- [x] 3.1 Update `agentic-coding/test/workflow-registry.test.ts` to assert both revised step lists, successful paths, retry edges, approval/reject/comments targets, terminal state, and absence of proposal downstream execution steps.
- [x] 3.2 Assert existing `standard`, `direct-apply`, `no-openspec`, `plan-fusion`, and `fusion-propose` routing/preset behavior remains intact except for the intended proposal approval/close lifecycle.

## 4. Dashboard and CLI surfaces

- [x] 4.1 Update dashboard state/action mapping under `agentic-coding/src/tui/dash/` to use the pinned proposal definition when rendering completion actions, hide proposal PR creation, and retain plan-approval review actions and explicit close/cleanup actions.
- [x] 4.2 Update `agentic-coding/test/dash/data.test.ts` and affected dashboard tests to cover proposal plan approval, completed-not-closed state, close action, and absence of proposal PR action while preserving generic/full-workflow behavior.
- [x] 4.3 Confirm CLI/dashboard startup continues forcing proposal checkout/same-checkout semantics and fusion planner routing without changing the other workflow types; extend focused tests only where the revised graph changes expectations.

## 5. Documentation and validation

- [x] 5.1 Update `README.md` workflow descriptions to document proposal plan approval, completed holding state, and explicit close without implementation or PR creation.
- [x] 5.2 Run focused workflow and dashboard tests, then `bun run lint`, `bun run type-check`, `bun run build`, and `openspec validate fix-propose-only-workflows --strict`; resolve all diagnostics without modifying generated embedded artifacts by hand.
