## Why

Workflow creation, workflow history and telemetry independently scan directories using inconsistent configuration paths. All discovery must use devenv's configured apps and libraries so the merged UI has one project authority.

## What Changes

- Expose a backend project catalog with stable configured identity, canonical repository root, active checkout, availability and capabilities.
- Replace all three recursive discovery paths and CLI project listing with the catalog; surface errors rather than silently scanning elsewhere.
- Keep repository-independent wiki/research workflows visible and preserve explicit authenticated CLI repository targeting.
- React to configured-project changes without retargeting active workflows.
- **BREAKING**: Unconfigured repositories cease to appear automatically. The operator must reconcile existing repositories into devenv's managed layout before cutover; no automatic relocation or external-path support is added.

## Capabilities

### New Capabilities

- `configured-workflow-project-catalog`: Shared configured project discovery and stable repository/worktree identity.

### Modified Capabilities

None; explicit workflow target and persisted identity contracts remain unchanged.

## Impact

Depends on `compose-unified-feature-shell` and manual project reconciliation. Touches Go app manager/routes, TypeScript client, `workflow/operations.ts`, `dash/observations.ts`, `dash/engine.ts` and `otel/model/db.ts`. Does not move databases or alter workflow pins.
