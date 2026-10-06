# Design

## Context

`WorkflowManifestPolicy` (`targetKind`, `checkoutRequired`,
`requiresReadOnlyResearcher`) already replaced start-time id checks and set the
precedent: policy is manifest data, adding it requires a new definition version
tier, and `effectiveManifestPolicy` falls back to a per-id table for older tiers.
Traits follow the same pattern exactly.

Branches by family today (non-exhaustive, to be inventoried in task 1.1):

| Property | Where it is read today |
| --- | --- |
| no OpenSpec change artifacts | `steps/implementation.ts` `CHANGE_FREE_IMPLEMENTATION`, `runtime/evidence.ts` start guards, `startup.ts` `validateStart` |
| fusion planning | `runtime/engine.ts` start, `reducers/developer-action.ts` switch-preset |
| change id = workflow id | `runtime/engine.ts` start (`openspec-apply`), evidence guard |
| no delivery / close only | `steps/lifecycle.ts` `CLOSE_ONLY_DEFINITIONS`, developer-action `create-pr` guard |
| start requirements | `runtime/evidence.ts` `validateStartEvidence`, `startup.ts` `validateStart` |
| OpenSpec verifier eligible | `steps/verification.ts` role filters |
| rebase checkout preparation | `effect-runner.ts`, `startup.ts`, `server/operations/engine.ts` `startArgs` |

## Inventory: repository-family id comparisons outside `definitions/` (task 1.1)

Every literal comparison against a repository code-change family id
(`openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`,
`openspec-fusion-propose`, `no-openspec`, `solo`, `rebase`, `verify`) outside
`src/workflow/definitions/`, with the property it decides. Verified against
`grep -rnE '"(openspec|openspec-apply|openspec-propose|openspec-fusion|openspec-fusion-propose|no-openspec|solo|rebase|verify)"' --include=*.ts --include=*.tsx src`
(minus git/CLI argument strings, path segments, and the `wiki`/`research`/
`wiki-comments` literals this change deliberately leaves alone).

| File:line | Symbol | Branch today | Trait |
| --- | --- | --- | --- |
| `steps/implementation.ts:12` | `CHANGE_FREE_IMPLEMENTATION` | `no-openspec`, `solo`, `verify` skip the OpenSpec change-evidence check in `validateEvidence` | `changeArtifacts: none` |
| `steps/lifecycle.ts:15` | `CLOSE_ONLY_DEFINITIONS` | `openspec-propose`, `openspec-fusion-propose`, `solo`, `rebase`, `verify` hide `create-pr` on `core.completed` | `delivery: none` |
| `steps/verification.ts:29,35` | `triageRolesFor`, `candidateRoles` | `no-openspec` drops the `openspec-verifier` role from triage and classifier candidates | `openspecVerifier: false` |
| `startup.ts:104-150` | `validateStart` | `verify` → base-branch rules; `no-openspec`/`solo` → non-empty task; `rebase` → both refs; `openspec-apply` → change artifacts; dirty tree unless proposal; OpenSpec project otherwise | `startRequirements` |
| `startup.ts:170,200` | `validateVerifyBase`, `validateRebaseBranches` | the two ref-shaped start guards invoked above | `startRequirements: base-commit` / `rebase-refs` |
| `startup.ts:284` | `resolveRoutingForStart` | `definitionId.startsWith("openspec-fusion")` seeds the planner roster from the fusion defaults | `planning: fusion` |
| `startup.ts:440,446` | `prepareFromContext` | `rebase`/`verify` force checkout mode and select their branch/base inputs | `startRequirements` |
| `startup.ts:473` | `prepareFromContext` | `openspec-propose`, `openspec-fusion-propose` (with `wiki`) set `sameCheckout` | (already `policy.checkoutRequired`) |
| `runtime/evidence.ts:350-475` | `validateStartEvidence` | the engine-boundary mirror of every `validateStart` rule above | `startRequirements` |
| `runtime/engine.ts:984` | `resolveStart` | `openspec-fusion`/`openspec-fusion-propose` → `validateFusionRouting` | `planning: fusion` |
| `runtime/engine.ts:993` | `resolveStart` | `openspec-apply` records `metadata.changeId = workflowId` at start | `changeIdentity: workflow-id` |
| `runtime/reducers/developer-action.ts:142` | preset switch reducer | `definition.id.startsWith("openspec-fusion")` re-seeds the planner roster | `planning: fusion` |
| `runtime/reducers/developer-action.ts:412` | `create-pr` reducer | proposal-only flows refuse `create-pr` with `unavailable` | `delivery: none` |
| `effect-runner.ts:1036` | `workspace.setup` handler | `rebase` prepares the checkout with `prepareRebaseCheckout` | `startRequirements: rebase-refs` |
| `server/operations/engine.ts:206-210` | `startArgs` | launcher maps `workflowType` to a family id and picks checkout mode (`openspec-propose`, `openspec-fusion-propose`, `wiki`) | family selection; `policy.checkoutRequired` |
| `server/operations/engine.ts:213,218,221` | `startArgs` | `rebase`/`verify` force checkout mode and carry the branch inputs | `startRequirements` |
| `runtime/migration.ts:256-263` | legacy config migration | old `workflowType`/`workflowModules` map onto `openspec`/`openspec-apply`/`no-openspec` | family selection (legacy) |
| `server/operations/observations.ts:1618` | `openSpecRoot` | a workflow with no `changeId` (`no-openspec`, `wiki`, `research`) lists no change artifacts | `changeIdentity: none` / `changeArtifacts: none` |
| `tui/dash/projections.ts:303,387` | plan-review and completion prompt builders | `openspec-propose`, `openspec-fusion-propose` are proposal-only (legacy fallback path) | `delivery: none` (presentation) |
| `tui/dash/ui/NewWorkflowModal.tsx:50-58,205,319-329,424,498,520` | modal field gating | proposal/rebase/verify families choose which start fields the launcher offers; `openspec-apply` requires a workflow id | `startRequirements`, `changeIdentity` (presentation) |
| `workflow/cli/schema.ts:50`, `tui/dash/App.tsx:152` | start-option enums | the accepted `--workflow`/`workflowType` values | family catalog |
| `workflow/cli/commands/start.ts:29` | `start` command | `flag(rest, "workflow") ?? "openspec"` — the default family when none is given | family catalog |
| `tui/dash/ui/NewWorkflowModal.tsx:193` | modal default | `context.kind === "independent" ? "research" : "openspec"` — the launcher's default family for the selected context | family selection (presentation) |

No reader is switched by this change: the traits table above is data plus a
parity test, and the readers keep their literals until
`read-family-traits-instead-of-ids` moves them one at a time. The `wiki`,
`wiki-comments`, and `research` literals in `contracts.ts`, `runtime/kernel.ts`,
`runtime/engine.ts`, `effect-runner.ts`, `steps/wiki.ts`, and
`cli/commands/wiki.ts` stay by design (Non-Goals).

## Goals / Non-Goals

**Goals:**

- One declared, validated source for every repository-family property the
  engine branches on.
- Zero changed readers, and no behavior change except the one contained
  research-policy correction recorded below.

**Non-Goals:**

- Traits for `wiki`, `wiki-comments` and `research`. They are documentation
  families with their own targets and steps; custom graphs will not produce them,
  so their id checks stay.
- Switching any reader (next change).

## Decisions

- **Traits live inside `policy`.** One manifest block, one validation path, one
  fallback function family (`effectiveManifestPolicy`, `effectiveFamilyTraits`).
- **New tier for all families.** Adding traits changes digests, so the tier is
  new. Families without traits are still registered in it unchanged, keeping
  "every family resolves at the newest tier" true.
- **Fallback table is the oracle.** The per-id table used for older tiers is the
  same table the new tier's manifests are built from, and the parity test reads
  both, so they cannot drift.
- **Structural validation.** `planning: fusion` requires `fusion.plan` in the
  graph; `planning: single` requires `core.plan`; `planning: none` forbids both;
  `delivery: pull-request` requires `core.delivery`; `changeArtifacts: none`
  forbids `core.archive`; `changeIdentity: workflow-id` **and** `planned` both
  require `changeArtifacts: openspec` (a family that produces no change declares
  `changeIdentity: none` — the value `openSpecRoot` in
  `server/operations/observations.ts` already reads as "no change id").
- **Exact names may be refined** during task 1.1's inventory if a branch needs a
  property the table above does not express; the parity test is the contract.
  The `changeIdentity: none` member above is that refinement, reached from the
  inventory's `openSpecRoot` row.
- **Research policy correction (developer-approved, beyond the original
  tasks).** `research` is registered in the new tier with
  `requiresReadOnlyResearcher: false`, applied *after* `withManifestPolicy`.
  Applying the catalog policy last is what the step-routing tier does, and it
  silently reverted the full-tool policy `definitionVersionForResearchTools`
  documents; the start guard then looks for a route named by
  `definition.initial`, which per-step routing has rewritten to the
  `core.route-research` system step, so **every** research start was refused
  whatever the researcher profile (verified against the real engine: `406`
  starts, `706` and `806` throw). Fixing it in the tier below is impossible
  (its digest is pinned by in-flight workflows) and in `runtime/engine.ts` is
  outside this change's impact, so the new tier carries the correction. Only
  versions 801..820 move and nothing was pinned to them, so no in-flight
  workflow is stranded; the alternative — publishing a tier on which a
  first-class family can never start — is worse. Every *other* tier keeps its
  graph, policy, and digest exactly.

## Risks / Trade-offs

- [A trait set misses a branch] → Task 1.1 inventories every repository-family
  literal outside `definitions/`; the next change's architecture guard fails on
  any literal left behind.
