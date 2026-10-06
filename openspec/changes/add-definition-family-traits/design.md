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

## Goals / Non-Goals

**Goals:**

- One declared, validated source for every repository-family property the
  engine branches on.
- Zero behavior change; zero changed readers.

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
  forbids `core.archive`; `changeIdentity: workflow-id` requires
  `changeArtifacts: openspec`.
- **Exact names may be refined** during task 1.1's inventory if a branch needs a
  property the table above does not express; the parity test is the contract.

## Risks / Trade-offs

- [A trait set misses a branch] → Task 1.1 inventories every repository-family
  literal outside `definitions/`; the next change's architecture guard fails on
  any literal left behind.
