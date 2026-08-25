## Context

`standard-propose` and `fusion-propose` already use the same checkout/workspace startup path and planning artifact validation as their full-workflow counterparts, but their manifests transition directly to `core.closed`. Entering `core.closed` invokes the existing terminal-step entry logic, which enqueues `workspace.close` and subsequently cleanup. The registry also requires every outcome of a non-terminal registered step to have a manifest edge, while the shared `core.completed` step supports both `close` and the general workflow `create-pr` action.

The change must therefore alter only proposal composition and its user-facing action surface. Full workflows retain their existing implementation, verification, archive, delivery, PR, and completion behavior; proposal workflows remain on the current checkout and do not create branches or worktrees.

## Goals / Non-Goals

**Goals:**

- Keep proposal workflows active at `core.plan-approval` after validated planning and at `core.completed` after approval.
- Make explicit developer close the only proposal completion path into `core.closed`, delaying workspace close/cleanup until then.
- Preserve planner/consolidator retry bounds and plan-review rejection/comments behavior, including review-fix context for comments.
- Keep proposal definitions free of implementation, verification, archive, delivery, and pull-request effects on their reachable user action path.
- Expose the plan gate and proposal completion/close actions in the dashboard without presenting proposal PR creation.
- Preserve all behavior for `standard`, `direct-apply`, `no-openspec`, `plan-fusion`, and existing non-proposal dashboard flows.

**Non-Goals:**

- No change to proposal startup guards, same-checkout semantics, branch handling, workspace setup, or OpenSpec artifact validation.
- No new workflow engine lifecycle model, effect type, API, or workspace implementation.
- No implementation of proposal artifacts or approval-triggered code changes.

## Decisions

1. **Compose both proposal manifests through the existing approval and completion steps.**
   `standard-propose` will use `core.plan`, `core.plan-approval`, `core.completed`, and `core.closed`; `fusion-propose` will use `fusion.plan`, `fusion.consolidate`, `core.plan-approval`, `core.completed`, and `core.closed`. Planning retry edges remain bounded at three attempts. Approval goes to `core.completed`; rejection and comments return to the appropriate planning step, with comments carrying the existing review-fix context. This reuses established contracts and dashboard action IDs instead of introducing proposal-specific steps.

2. **Use the existing terminal entry hook for delayed workspace cleanup.**
   No `workspace.close` is scheduled when planning or approval completes. `core.completed` remains a developer state with a `close` action; only its transition to `core.closed` invokes the existing `core.closed` entry behavior that enqueues `workspace.close`, whose completed effect then enqueues `workspace.cleanup`. This keeps cleanup idempotency and effect ordering unchanged.

3. **Restrict PR creation at the runtime action boundary for proposal definitions.**
   The shared registered `core.completed` contract must retain its `create-pr` outcome and edge for full workflows. Proposal manifests will retain the contract-required bounded self-loop for that outcome, but runtime available actions and direct action authorization will omit `create-pr` when the pinned definition is `standard-propose` or `fusion-propose`. Consequently, the only reachable proposal developer action from `core.completed` is `close`, and no `pull-request.create` effect can be requested by a proposal run.

4. **Drive dashboard behavior from the pinned definition and current step.**
   The dashboard will continue to use `core.plan-approval` and engine-returned actions for plan review. Completion user-action rendering will receive the definition ID and hide PR choices for proposal definitions while retaining close/cleanup choices where applicable. The current step/status from the engine remains authoritative, so proposals are not rendered as closed while awaiting approval or explicit close.

5. **Update requirements and regression coverage at the existing seams.**
   Registry tests will assert the revised manifests and forbidden step/effect paths. Runtime/effect tests will exercise plan validation, approval, rejection/comments, completion, close, and workspace effect ordering. Dashboard tests will cover proposal completion actions and plan-approval presentation. README workflow descriptions and the proposal-only capability spec will describe the explicit approval and close lifecycle.

## Risks / Trade-offs

- [Shared completion contract exposes a generic PR outcome internally] → Filter proposal actions and reject proposal `create-pr` commands before enqueueing any effect; test both returned actions and direct command rejection.
- [Existing pinned proposal workflows use the old direct-to-closed graph] → Treat the graph change as a new registry digest/version policy outcome and keep tests focused on newly registered definitions; do not reinterpret an already pinned digest.
- [A failed workspace-close effect could leave a completed workflow open operationally] → Preserve existing durable effect retry/attention handling and cleanup chaining rather than adding a second close mechanism.
- [Dashboard phase fixtures use legacy `proposed`/`completed` strings] → Keep compatibility for generic fixture helpers while adding definition-aware assertions for real proposal states.

## Migration Plan

1. Register the revised proposal graphs and update runtime/dashboard code, tests, specifications, and README together.
2. Validate the registry and run focused workflow/dashboard tests, then the repository-required lint, type-check, build, and strict OpenSpec validation checks.
3. Existing workflows remain pinned to their recorded definition digest. New proposal starts use the revised graph; any old pinned proposal is handled by the existing pin-mismatch/recovery policy rather than silently changing state.

## Open Questions

None.
