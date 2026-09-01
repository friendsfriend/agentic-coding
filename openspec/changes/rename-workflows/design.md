## Context

See `proposal.md` for motivation and the approved breaking rename mapping. The workflow IDs are used in built-in manifests, start validation, routing, persisted snapshots, action availability, dashboard projections, CLI help, tests, and profile defaults. `NewWorkflowModal` currently keeps separate arrays for workflow keys and display labels, and `ListViewModal` allocates one terminal row per item. `wiki-comment-review` is an internal UI-only definition and must remain absent from public start choices. `embedded.generated.ts` is generated and must not be hand-edited.

## Goals / Non-Goals

**Goals:**

- Make the new technical IDs authoritative everywhere the workflow engine accepts, stores, or compares definitions.
- Use one metadata catalog for public modal choices, including technical ID, UI label, description, and the retained `quick` alias for `no-openspec`.
- Display descriptions as additional workflow-choice information while removing every parenthesized fragment from all modal labels, option values, and workflow display text.
- Preserve each workflow graph, routing semantics, lifecycle, and public/private exposure rule apart from the requested naming changes.
- Make the breaking nature of old IDs explicit through tests and updated CLI/help behavior.

**Non-Goals:**

- No compatibility migration for old persisted definition IDs or old CLI workflow flags.
- No change to workflow step IDs, graph transitions, retry limits, agent roles, or wiki/research boundaries.
- No exposure of `wiki-comments` in the New Workflow modal or CLI.
- No new dependency and no hand edit to generated workflow assets.

## Decisions

### Centralize public workflow metadata

Export a small immutable workflow catalog from the workflow definition area. Each public entry contains the new technical ID, UI label, description, and optional modal alias; the catalog covers `openspec-full`, `openspec-apply`, `no-openspec`, `openspec-fusion-full`, `openspec-propose`, `openspec-fusion-propose`, `wiki`, and `research`. Keep `quick` as an alias that resolves to `no-openspec`, rather than creating a second definition or duplicating descriptions in the modal. Keep `wiki-comments` out of this public catalog.

This is preferred over another UI-only map because CLI help, dashboard startup, and modal filtering must agree on the same public IDs. It also avoids deriving user-facing labels from internal step names. A separate registry/plugin abstraction is unnecessary because the built-in definition module already owns the catalog and is the source used to register manifests.

### Render descriptions within workflow choice rows

Extend the generic list modal with an optional row height, defaulting to its current one-line behavior. The workflow-type list opts into a two-line row: the first line renders the UI label and the second line renders the description in a muted color. Selection and filtering continue to operate on the technical/alias key, not rendered text. Replace useful parenthesized option context with plain text (for example, a colon-separated current-directory name, `Config defaults`, and a standalone `Research` option); workflow-specific caveats belong in the descriptions. This keeps other lists unchanged and makes long workflow descriptions readable without encoding caveats into field labels.

### Rename IDs directly and reject stale names

Change manifest IDs and every source comparison, start flag allowlist, routing branch, action guard, status projection, and test fixture to the approved IDs. Change the default from `standard` to `openspec-full`; map `quick` directly to `no-openspec`; map the modal's other choices directly to their new IDs. Remove obsolete in-flight pin exceptions keyed by old definition IDs so stale persisted snapshots fail the existing pin/definition validation instead of being silently reinterpreted.

A compatibility alias/migration was considered but rejected because the developer explicitly chose a breaking rename. The old names may remain only in migration-focused negative assertions or historical prose where they are not accepted inputs.

### Keep internal wiki-comments behavior private

Rename the UI-only definition and all internal checks to `wiki-comments`, including the dedicated home start path and centralized-wiki effect routing. Do not add it to the public catalog, CLI workflow allowlist, or New Workflow modal. The repository-backed public documentation workflow is independently renamed from `wiki-only` to `wiki`.

## Risks / Trade-offs

- [Breaking identifiers] Existing snapshots, configuration keys, scripts, and CLI invocations using old IDs will stop resolving. → Update repository fixtures and documented surfaces, explicitly test rejection/absence of old public flags, and document the intentional break in the proposal/specs.
- [Catalog/manifest drift] A modal entry could point at a definition that is not registered. → Add focused catalog/registry assertions that every public catalog ID resolves and that `quick` resolves only to `no-openspec`.
- [Terminal row height] Two-line choices consume more vertical space in small terminals. → Make the height opt-in, keep descriptions concise, and preserve the existing bounded modal list/scroll behavior.
- [Generated asset drift] Build output may contain embedded copies of source instructions or tests may import generated assets. → Never hand-edit `src/workflow/embedded.generated.ts`; run the required build and verify generated output is produced by the existing build script.

## Migration Plan

This is an intentional breaking release rather than a data migration. Deploy the source and regenerated build together, update all repository tests/configuration fixtures to the new IDs, and require users to restart or recreate workflows persisted under old IDs. Rollback is a source/build rollback; no forward data migration is introduced.
