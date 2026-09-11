## Context

Depends on `compose-unified-feature-shell` and operator-completed project reconciliation. Current discovery occurs in `workflow/operations.ts:listProjects`, `dash/observations.ts:listWorkflows` and `otel/model/db.ts:discoverProjectRepos`. devenv config lists apps and libraries while `localDirectoryPath` tracks the active checkout, not necessarily the canonical repository.

## Goals / Non-Goals

**Goals:** One configured catalog for picker/history/telemetry/CLI, stable identity, explicit unavailable-project diagnostics.

**Non-Goals:** Auto-relocation, external-checkout support, auto-clone, merging databases or removing repository-independent workflows.

## Decisions

1. Go app manager remains catalog authority until its later Bun port. Add `GET /api/projects` returning configured apps/libraries, stable `ident`, display name, canonical root, active checkout, availability and capabilities. Validate duplicate identifiers across both lists rather than guessing from labels. Missing paths retain configured identity and report availability; they do not fail the entire list or trigger cloning.
2. Resolve canonical repositories using Git common-directory semantics, preserving linked-worktree behavior. Treat configured ident, canonical repository and active checkout as distinct values. De-duplicate history/watch reads by canonical root while retaining aliases/configured entries. For uncloned projects retain the expected managed location and mark canonical resolution unavailable.
3. One asynchronous catalog client supplies workflow creation, history loading, telemetry watch setup and CLI `workflow projects`. Local headless listing connects to the same configured server, or starts a bounded catalog-only invocation of the embedded backend without pollers/actions; it never reparses config into a second independent implementation. Before unified packaging, the imported Go executable supports this read-only invocation. After Bun port the same CLI invokes the canonical Bun catalog boundary.
4. Replace recursive walk call sites and pass explicit catalog roots to observation subprocesses. Remove default cwd/development-root and legacy TOML scanners; `--repo` for explicit workflow commands remains valid and authenticated independently from discoverability. Preserve wiki://centralized and research://standalone global targets separately.
5. Catalog revision/change notification triggers project-list refresh and watcher diffing. Removing a project stops new discovery watches but does not delete histories or terminate active workflows. Existing active workflows retain their pinned repository/worktree; direct detail routes stay usable with a removed-project diagnostic.
6. OpenSpec capability is a bounded read of the canonical/selected project configuration, not a requirement that all configured libraries already have OpenSpec. Empty catalog is a valid state with configuration guidance, not fallback scanning.

## Risks / Trade-offs

- Manual move strands active workflows → require operator checklist and consistent backups; no cutover while known active absolute-path references remain unresolved.
- Worktree switch duplicates or hides history → canonical-root fixtures, active-checkout change tests and pinned workflow assertions.
- Server unavailable resembles no projects → separate transport/configuration errors from empty results and offer retry.
- Headless discovery starts destructive background services → catalog-only invocation must not construct normal server poller lifecycle.

## Migration Plan

Inventory intended configured IDs/paths and verify manual reconciliation first. Add catalog API/fixtures, update each discovery consumer, then remove scanners together. Compare expected IDs, workflow histories and telemetry roots. Rollback restores discovery code only; neither cutover nor rollback moves data/config files. No database schema change is necessary.

## Open Questions

Operator must supply/confirm reconciled project inventory before implementation cutover. This is an explicit prerequisite, not a request to build automatic migration tooling.
