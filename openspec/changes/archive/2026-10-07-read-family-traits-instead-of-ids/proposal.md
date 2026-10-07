# Proposal

## Why

After `add-definition-family-traits` every repository code-change definition has
declared traits, but the engine still decides by comparing definition ids. A
definition with an id the engine has never seen — a composed custom workflow —
would get default behavior everywhere: wrong start guards, wrong completion
actions, wrong verifier set. Readers must consult the traits.

## What Changes

- Step behaviors receive the pinned definition's effective traits in their hook
  inputs (`roles`, `candidateRoles`, `validateEvidence`, `developerActions`,
  `onArrive`, …) next to `definitionId`.
- Every repository-family id branch inventoried in the traits change reads the
  trait instead: implementation change-free mode, verifier eligibility, close-only
  completion, start evidence guards, fusion planning, `openspec-apply` change
  identity, propose-only delivery guard, rebase checkout preparation, the
  start-boundary checks in `startup.ts`, and the mode forcing in `startArgs`.
- An architecture test fails on any repository code-change family id literal in
  `src/workflow/` or `src/server/` outside `definitions/` and the catalog (wiki,
  research and wiki-comments literals stay allowed).
- No behavior change for any built-in family: the existing suites are the oracle.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-definition-registry`: the engine reads family traits instead of
  repository family identifiers.

## Impact

- `src/workflow/steps/types.ts` (hook input), `steps/implementation.ts`,
  `steps/verification.ts`, `steps/lifecycle.ts`, `steps/gates.ts` as needed.
- `src/workflow/runtime/evidence.ts`, `runtime/engine.ts`, `runtime/kernel.ts`,
  `runtime/reducers/developer-action.ts`, `effect-runner.ts`,
  `src/workflow/startup.ts`, `src/server/operations/engine.ts`.
- New architecture test beside `test/workflow-source-layer-boundaries.test.ts`.
- Depends on `add-definition-family-traits`.
