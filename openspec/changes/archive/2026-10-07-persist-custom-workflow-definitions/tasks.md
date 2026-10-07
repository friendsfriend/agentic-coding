# Tasks

## 1. Validation and storage

- [x] 1.1 Extract `compileWorkflow` from `registerWorkflow` (no behavior change) and reserve the `custom.` namespace for non-built-ins. Verify registry tests unchanged plus namespace rejection tests.
- [x] 1.2 Add the newest-tier invariant check for custom manifests (exact step refs, non-empty label, policy + traits, routing coverage, gate placement). Verify a rejection test per invariant.
- [x] 1.3 Add store v5 (`workflow_definitions`) with its migration and shape classification. Verify the store migration suite: v4 → v5, interrupted migration, newer-version fail-closed.

## 2. Resolution

- [x] 2.1 Add the definition resolver (built-in → store → compile + cache) and route all `registry.definition(...)` call sites through it. Verify the full engine suite unchanged for built-ins.
- [x] 2.2 Fail closed when a stored definition no longer compiles, blocking its workflows with a diagnostic naming the step. Verify with a fixture whose step version is unregistered.

## 3. Operator path

- [x] 3.1 Add `workflow define --repo PATH --file FILE` and accept a stored custom id in `workflow start --type`. Verify an end-to-end test: define, start, restart the engine, dispatch.
- [x] 3.2 Update `docs/workflow-architecture.md` (store versions, resolver); run `bun run lint`, `bun run type-check`, `bun run build` and the workflow suites.
