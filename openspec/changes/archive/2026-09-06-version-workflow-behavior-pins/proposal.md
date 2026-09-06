## Why

Workflow digests exclude behavior, and manifests resolve step IDs through default version 1. Keeping old graph versions therefore does not preserve their execution semantics when current behavior changes. Digest fixtures alone cannot prove upgrade compatibility.

## What Changes

- Define separate guarantees for graph/contracts, executable behavior, and presentation-only instructions.
- Pin explicit behavior compatibility versions and exact step references for new workflow definitions.
- Resolve every runtime, routing, assignment, and view lookup through the workflow's pinned step references.
- Preserve historical digests and provide a documented legacy compatibility mapping rather than rewriting existing pins implicitly.
- **BREAKING:** Incompatible semantic upgrades require a retained implementation or an explicit validated migration; changing behavior is no longer universally permitted without compatibility checks.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-definition-registry`: Versioned executable semantics and exact step resolution alongside definition pinning.

## Impact

- Priority: high; architecture finding 3. No prerequisite changes.
- Code: `agentic-coding/src/workflow/registry.ts`, `definitions/`, `steps/`, contracts, runtime lookups, assignment generation, routing, and repair/repin paths.
- Tests must cover old and new behavior implementations with identical graph structure, not only digest fixtures.
- Legacy mappings describe supported compatibility with the current baseline; they cannot reconstruct unrecorded historical behavior.

## Non-goals

No function-source hashing, workflow plugin discovery, automatic migration on status reads, or requirement to pin cosmetic instruction edits as executable behavior.
