## Why

Developers need to compare or prepare plans without handing control to implementation, while a full workflow continues in the same checkout. The current workflow catalog always proceeds from planning into approval and code-changing phases, and checkout startup assumes exclusive ownership of the repository branch, preventing safe parallel proposal-only runs.

## What Changes

- Add `standard-propose` and `fusion-propose` workflow definitions that reuse the existing planning steps and stop after a validated plan proposal, without approval, implementation, verification, archive, delivery, or pull-request effects.
- Expose both proposal-only definitions through the CLI and dashboard workflow selection, including fusion planner routing and task input.
- Start proposal-only workflows in checkout mode on the currently checked-out branch and repository itself; do not create, switch, or remove a Git branch or worktree.
- Permit proposal-only startup alongside another checkout workflow, including when the checkout has unrelated or sibling-workflow changes, while retaining unique change IDs and isolated OpenSpec artifact directories.
- Keep Herdr workspace creation and cleanup safe for a repository-backed proposal workspace; cleanup must never remove the repository checkout.
- Add registry, lifecycle, effect-runner, CLI, and dashboard coverage and document the new workflow identifiers.

## Capabilities

### New Capabilities

- `workflow-proposal-only`: Planning-only standard and fusion workflows that produce validated OpenSpec proposals in the current checkout and terminate before developer approval or implementation.

### Modified Capabilities

- `workflow-definition-registry`: Register the two explicit proposal-only workflow graphs while preserving the identifiers, graphs, and pins of existing full definitions.
- `workflow-plan-fusion`: Extend fusion planning and dashboard selection requirements to cover the proposal-only fusion variant, which terminates after consolidation rather than entering standard approval and execution.

## Impact

Affected areas include the built-in workflow registry and runtime, checkout/workspace effect handling, CLI start validation and help, dashboard engine and new-workflow modal, README usage documentation, and workflow/dashboard tests. No new dependency or public service API is required. Existing full workflows retain their current routing and branch/worktree behavior; proposal artifacts use the caller-provided change ID and remain isolated from other workflow change directories.
