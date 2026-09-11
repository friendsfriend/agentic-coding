## Why

Git, provider and AI integrations form a large independent backend surface that can move behind the stable API before container execution. Porting them with parity fixtures preserves mature devenv issue, review and CI behavior.

## What Changes

- Port Git inspection/worktree operations, provider configuration, repository search, GitHub/GitLab issues, change requests, discussions and CI.
- Preserve server-side search/filter/sort/pagination and provider-specific behavior.
- Port Pi session discovery, streamed log analysis and change-request AI review, including scoped callbacks and temporary-worktree cleanup.
- Retain operational command ownership through the existing action owner; provide private operation adapters where Go actions invoke newly ported capabilities.
- Cut routes over individually after read/fixture parity, never by replaying mutations against both backends.

## Capabilities

### New Capabilities

- `bun-development-integrations`: Compatible Bun Git/provider/CI and AI/session services.

### Modified Capabilities

None; workflow handoff and Herdr adapters remain separate and unchanged.

## Impact

Depends on `port-project-catalog-and-state-to-bun`. Touches imported Git/provider/GitHub/GitLab/issues packages, server integration handlers and corresponding TS clients. External Herdr remains a dependency; no replacement agent orchestrator is introduced.
