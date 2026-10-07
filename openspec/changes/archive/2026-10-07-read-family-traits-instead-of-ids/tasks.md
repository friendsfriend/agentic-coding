# Tasks

## 1. Steps

- [x] 1.1 Pass effective traits into every step behavior hook input. Verify type-check and the step behavior suites unchanged.
- [x] 1.2 Convert `steps/implementation.ts`, `steps/verification.ts` and `steps/lifecycle.ts` family-id branches to traits. Verify `test/workflow-steps.test.ts` and the verifier role tests unchanged.

## 2. Runtime

- [x] 2.1 Convert `runtime/evidence.ts` start guards, `runtime/engine.ts` start (fusion roster, change identity) and `reducers/developer-action.ts` (fusion switch-preset, close-only `create-pr`). Verify the engine/start-guard suites unchanged.
- [x] 2.2 Convert `effect-runner.ts` rebase checkout preparation. Verify the rebase family tests unchanged.

## 3. Start boundary and guard

- [x] 3.1 Convert `startup.ts` (`validateStart`, `prepareFromContext`) and `server/operations/engine.ts` `startArgs` to read policy and traits. Verify startup tests for every family.
- [x] 3.2 Add the architecture test forbidding repository code-change family id literals outside `definitions/` and the catalog. Verify it fails on a planted literal and passes on the tree.
- [x] 3.3 Run `bun run lint`, `bun run type-check`, `bun run build` and the full workflow suites with zero new failures.
