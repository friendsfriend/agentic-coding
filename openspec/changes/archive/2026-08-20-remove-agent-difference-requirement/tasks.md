## 1. Config and routing enforcement

- [x] 1.1 Remove `runtime_diversity` from the `AgentsConfig` interface and its parsing in `src/workflow/profiles.ts`.
- [x] 1.2 Remove the diversity computation and throw-on-violation check from `resolveRouting` in `src/workflow/profiles.ts`; `resolveRouting` returns only `defaultProfile` and `routes`.

## 2. Contracts and persisted state

- [x] 2.1 Remove the `diversity` field from the `WorkflowRouting` interface in `src/workflow/contracts.ts`.
- [x] 2.2 Update `parseSnapshot` in `src/workflow/contracts.ts` so `routing.diversity` is no longer required on read (accept and ignore if present on old persisted snapshots, do not fail when absent).
- [x] 2.3 Update the two `diversity: []` construction sites in `src/workflow/runtime.ts` to stop setting the field.

## 3. Tests

- [x] 3.1 Update `test/workflow-adapters.test.ts` to remove `runtime_diversity` config and `routing.diversity` assertions from the "routing precedence and diversity are deterministic" test (rename/retitle as needed to reflect precedence-only coverage).
- [x] 3.2 Search remaining tests for `runtime_diversity` / `.diversity` usage and update or remove any other references so the suite reflects the removed constraint.
- [x] 3.3 Add/confirm a test demonstrating that routing two constrained roles (e.g. plan/worker equivalent roles) to the same runtime succeeds without error.

## 4. Spec and validation

- [x] 4.1 Confirm the delta spec at `openspec/changes/remove-agent-difference-requirement/specs/agent-runtime-routing/spec.md` removes the "Optional runtime diversity constraints" requirement with reason and migration notes.
- [x] 4.2 Run `openspec validate remove-agent-difference-requirement --strict` and resolve any reported issues.
- [x] 4.3 Run the affected test files (`test/workflow-adapters.test.ts` and any workflow contract/runtime tests) to confirm no remaining reference to the removed diversity mechanism breaks the build.
