## Why

Documentation work currently has to be attached to a code-changing workflow, even when the requested outcome is knowledge in the centralized wiki and the source repository is only evidence. A dedicated workflow will support repository initialization, feature documentation, and business-knowledge updates while keeping the source repository required as read-only context and making the wiki the only writable project output.

## What Changes

- Add a `wiki-only` workflow definition whose lifecycle is dedicated wiki documentation, developer review, and explicit close.
- Require a source repository for startup and use its checkout only as read-only evidence; do not create or switch branches, create worktrees, modify source files, run implementation/verification/archive/delivery steps, or create pull requests.
- Reuse the existing wiki agent and approval/review surfaces, including snapshot-based review and engine-owned human verification of approved concepts.
- Expose the workflow through the CLI and dashboard workflow-selection/start paths with documentation-specific labels and input guidance.
- Permit the workflow to run against an occupied or dirty source checkout because it does not claim source-repository changes, while preserving the existing guards for code-changing workflows.
- Add focused tests for registration, graph reachability, start guards, read-only/source-isolation behavior, CLI/dashboard exposure, and the complete wiki-only lifecycle.

## Capabilities

### New Capabilities

- `wiki-only-workflow`: A repository-backed workflow that writes only centralized wiki concepts, supports developer review, and closes without code, archive, delivery, or pull-request effects.

### Modified Capabilities

- `knowledge-wiki`: Clarify that the dedicated documentation and wiki-approval lifecycle may be used by an archive-free wiki-only workflow, while preserving draft provenance, snapshot review, and engine-owned human promotion.
- `workflow-definition-registry`: Register and validate the explicit `wiki-only` workflow graph and ensure its reachable lifecycle has no code-changing or delivery effects.

## Impact

- Workflow engine definitions, startup validation, routing, effect authorization, and CLI/dashboard workflow selection in the `agentic-coding` package.
- Focused workflow, CLI, and dashboard tests plus the pinned workflow documentation/assets as needed for the new assignment.
- The managed run still requires a source repository and its branch metadata for evidence, but its intended external mutation is limited to the centralized OKF wiki; it must not alter source-repository files or Git state.
- Existing workflow definitions and their clean-tree/code-changing behavior remain unchanged.
