## Why

The new-workflow wizard currently embeds caveats in step labels and presents workflow types without concise, reusable descriptions. Workflow identifiers and labels also mix legacy names with their actual OpenSpec, research, and wiki roles, making CLI state and dashboard terminology harder to understand. This change establishes the requested technical/UI naming scheme and makes the rename explicit, including the intentional breaking impact on existing identifiers.

## What Changes

- Remove every parenthesized fragment from the new-workflow modal's labels, selectable values, and workflow display text; replace useful context with plain wording or workflow choice descriptions.
- Add a workflow catalog used by the modal so each selectable workflow has a technical ID, UI label, and description, while retaining `quick` as the modal alias for `no-openspec`.
- Rename built-in workflow definition IDs and their UI labels:
  - `standard` → `openspec-full`; `Openspec`
  - `standard-propose` → `openspec-propose`; `Openspec Propose Only`
  - `direct-apply` → `openspec-apply`; `Openspec apply`
  - `no-openspec` → `no-openspec`; `No OpenSpec`
  - `plan-fusion` → `openspec-fusion-full`; `Openspec fusion`
  - `fusion-propose` → `openspec-fusion-propose`; `Openspec fusion propose`
  - `research` → `research`; `Research`
  - `wiki-only` → `wiki`; `Wiki`
  - `wiki-comment-review` → `wiki-comments`; `Wiki Comments`
- Update CLI flags, dashboard routing, runtime guards, profile selection, status/actions, tests, and specifications to use the renamed technical IDs. **BREAKING**: existing persisted workflow IDs and old CLI workflow flags do not need compatibility support.
- Keep the UI-only wiki-comments workflow out of the CLI and New Workflow modal, as required by its existing behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-definition-registry`: rename the registered workflow identifiers and labels while preserving their explicit graphs and pinning semantics.
- `direct-apply-workflow`: rename the direct OpenSpec apply definition and exposed start/status terminology.
- `no-openspec-workflow`: retain the no-OpenSpec definition identity while standardizing its UI presentation and modal alias.
- `workflow-plan-fusion`: rename full and proposal fusion definitions and their dashboard selection terminology.
- `workflow-proposal-only`: rename both proposal-only technical IDs and exposed CLI/dashboard names.
- `wiki-only-workflow`: rename the repository-backed documentation definition to `wiki` and update its surfaces.
- `research-workflow`: update the research UI catalog and descriptions without changing its technical ID or lifecycle.
- `wiki-comment-workflow`: rename the internal UI-only definition to `wiki-comments` without exposing it as a public start option.

## Impact

The implementation affects the TypeScript workflow definition catalog, runtime and CLI comparisons/help, dashboard startup and display projections, the New Workflow modal, focused dashboard/workflow tests, and the listed OpenSpec capability specifications. No new dependency is required. The definition digest/version behavior remains pinned, but renamed IDs intentionally require current definitions and invalidate old technical identifiers.
