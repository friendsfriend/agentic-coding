## Context

The built-in catalog currently contains `standard`, `direct-apply`, `no-openspec`, and `plan-fusion`. `standard` enters `core.plan-approval` after planning, while `plan-fusion` enters that gate after `fusion.consolidate`; both eventually expose implementation, verification, archive, and delivery. Workflow startup also rejects a dirty checkout and the workspace setup effect switches the checkout to the workflow branch whenever checkout mode is used.

The requested proposal variants are read-only with respect to source code, but their planning agents still create the normal OpenSpec change artifacts and run OpenSpec validation. They must therefore have separate change IDs/artifact directories while sharing the repository checkout and Herdr pane workspace with no Git branch/worktree ownership. The engine remains the lifecycle authority, and all existing full definitions must remain pinned and behaviorally unchanged.

## Goals / Non-Goals

**Goals:**

- Register explicit `standard-propose` and `fusion-propose` graphs.
- Run normal structured planning and OpenSpec artifact validation, then stop at `core.closed` before developer approval or any code-changing phase.
- Require checkout mode for proposal starts and use the repository and branch already checked out without Git switch, branch creation, or worktree creation.
- Allow a proposal run to start alongside a full checkout run, including when the repository is dirty, while retaining change-ID uniqueness and per-change artifact isolation.
- Preserve fusion fan-out constraints, planner profile distinctness, consolidator routing, retries, and dashboard/CLI parity.
- Close the Herdr workspace without ever removing the repository checkout.

**Non-Goals:**

- No new generic checkout mode such as `propose`; proposal behavior is selected by the workflow definition and exposed as checkout mode.
- No approval action, handoff to implementation, automatic follow-up workflow, commit, push, pull request, archive, or source-code edit phase.
- No changes to the graphs, versions, digests, branch naming, or clean-start policy of full workflows.
- No protection against a separate full checkout workflow switching the globally shared Git branch after proposal startup; this remains an inherent checkout-mode concurrency limitation.

## Decisions

### 1. Stop directly after the planning proposal

`standard-propose` starts at `core.plan` and routes `complete` directly to `core.closed`; `fusion-propose` starts at `fusion.plan`, routes successful consolidation directly to `core.closed`, and retains the existing fusion retry/self-loop edges. Neither graph includes `core.plan-approval`, `core.completed`, implementation, verification, archive, delivery, or pull-request effects. Entering `core.closed` uses the existing workspace-close/cleanup lifecycle, whose cleanup already skips Git worktree removal when worktree equals repository.

This resolves the planner disagreement in favor of the user's explicit “stop after the plan proposal” requirement. The alternative of including `core.plan-approval` and ending after approval was rejected because approval is already the next gate in the full workflows and would not stop immediately after proposal. A direct terminal transition is also preferable to inventing a second approval or follow-up action.

### 2. Use checkout mode as a definition-specific same-checkout policy

The CLI requires `--mode checkout` for both proposal IDs; `--mode worktree` is rejected. The dashboard fixes the mode to checkout and omits its mode picker for proposal choices. Runtime startup carries an explicit proposal/same-checkout policy derived from the definition ID rather than adding a third public mode. This keeps the requested surface compatible with existing checkout mode and avoids making a generic mode promise for future workflows.

At setup, the proposal handler resolves the repository as its worktree, verifies/records the current non-detached branch, recovers or creates only the Herdr workspace, and ensures its tabs. It never invokes Git branch, switch, or worktree commands. The actual current branch is stored as proposal metadata rather than fabricating the configured full-workflow branch name. Full workflow setup retains its existing behavior.

The alternative of adding a `propose` mode was rejected because the request explicitly describes parallel execution in checkout mode; a definition-specific policy provides the same safety without expanding the mode vocabulary. Proposal startup may bypass only the dirty-tree rejection. All other start guards, OpenSpec checks, routing checks, and unique change-ID checks remain active.

### 3. Reuse existing planning and fusion contracts

The proposal definitions reference the existing `core.plan`, `fusion.plan`, and `fusion.consolidate` steps, including instruction assets, output schemas, allowed effects, and retry bounds. Fusion variants apply the same 2–5 planner count, contiguous role, distinct-profile, and consolidator-route validation as `plan-fusion`. The consolidation instruction continues to require all validated drafts and creation of the normal OpenSpec artifact set, with rejected alternatives and applicable risks recorded in the design.

No new agent protocol or output schema is introduced. This avoids diverging plan quality or making proposal artifacts insufficient for later developer use.

### 4. Keep CLI and dashboard routing symmetrical

The CLI allow-list, help text, workflow-mode validation, fusion-profile parsing, current-branch metadata, and dirty-start exception are updated together. Dashboard start argument mapping, fusion preset validation, role derivation, fixed checkout behavior, and modal labels/task fields use the same definition IDs and rules. Existing `quick` to `no-openspec` mapping and all full workflow choices remain unchanged.

### 5. Preserve registry pinning and cleanup safety

Both proposal manifests are generated for each existing verification-round policy, as are the current built-ins. Registry tests will assert the new explicit compositions and separately assert that full definitions remain unchanged. Each started workflow records its exact definition version and digest. Effect tests will verify that repository-backed cleanup closes the Herdr workspace but never calls `git worktree remove` or deletes the repository.

## Risks / Trade-offs

- **[Shared checkout race]** A full checkout workflow can switch the globally shared branch while a proposal is active. → Proposal setup never switches branches; document and test the remaining observation race as an inherent checkout-mode limitation.
- **[Dirty-tree exposure]** Proposal agents read a checkout containing unrelated or sibling-workflow changes. → Bypass only the proposal clean-tree guard, keep scoped assignments and OpenSpec change IDs isolated, and ensure proposal steps have no implementation/delivery effects.
- **[Artifact collision]** Two runs could target the same OpenSpec change directory. → Retain the canonical store's unique change-ID rejection and require separate caller-provided change IDs; do not add shared artifact paths.
- **[Repository cleanup]** A generic cleanup implementation could remove the real repository if it treats a repository-backed worktree as a linked worktree. → Keep the existing repository-equality guard and assert it in effect-runner tests.
- **[Catalog compatibility]** Registering two definitions per policy changes enumeration and catalog contents. → Keep existing IDs and full manifests unchanged, preserve version/digest pinning, and update exact-count/registry expectations.
- **[Surface drift]** CLI and dashboard have separate routing paths. → Add parity tests for workflow IDs, task fields, fixed checkout behavior, fusion presets, and invalid planner configurations.

## Migration Plan

No persisted-state migration is required. Deploy the new catalog and routing code, then start proposal runs with unique change IDs and `--mode checkout`. Existing workflows continue to resolve their pinned definitions. Rollback is a code/catalog rollback; already-created proposal workspaces can be closed through the existing workflow close/cleanup effects, and their OpenSpec change directories remain ordinary repository artifacts for operator disposition.

## Open Questions

None. The requirement to stop after the plan proposal selects a direct planning-to-closed graph; the request selects checkout mode rather than a new mode name; and the existing fusion instructions establish that proposal planning creates and validates the normal OpenSpec artifact set.
