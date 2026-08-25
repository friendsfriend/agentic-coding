## 1. Workflow definitions and registry

- [x] 1.1 Add `standard-propose` and `fusion-propose` manifests in `agentic-coding/src/workflow/definitions.ts`, preserving the existing full manifests and routing successful planning directly to `core.closed` with planning retry loops only.
- [x] 1.2 Ensure proposal manifests are registered for every existing definition-version/verification-round policy and validate their allowed steps, outcomes, terminal reachability, and effects through the public registry contract.
- [x] 1.3 Extend `agentic-coding/test/workflow-registry.test.ts` to assert proposal registration, initial/terminal steps, planning-only composition, retry edges, and unchanged full workflow definitions.

## 2. Same-checkout runtime and effects

- [x] 2.1 Update `agentic-coding/src/workflow/runtime.ts` to apply fusion planner-count/profile validation to `fusion-propose`, require checkout mode and a named current branch for proposal starts, bypass the dirty-tree guard only for proposal definitions, and preserve unique change-ID enforcement.
- [x] 2.2 Update `agentic-coding/src/workflow/effect-runner.ts` so proposal workspace setup uses the repository as worktree and the current branch, creates or recovers only the Herdr workspace, never switches/creates branches or creates worktrees, and safely closes/cleans up without removing the repository.
- [x] 2.3 Preserve full-workflow workspace setup behavior and add runtime/effect tests covering same-branch setup, detached-branch rejection, dirty/shared checkout startup, no Git mutation, usable Herdr workspace identity, and repository-safe cleanup in `agentic-coding/test/workflow-effects.test.ts` and `agentic-coding/test/workflow-runtime.test.ts`.
- [x] 2.4 Add lifecycle coverage in `agentic-coding/test/workflow-e2e.test.ts` for standard and fusion proposal completion, including validated planning/consolidation, transition to `core.closed`, and absence of approval, implementation, verification, archive, delivery, and pull-request effects.

## 3. CLI workflow surface

- [x] 3.1 Update `agentic-coding/src/workflow/cli.ts` to accept both proposal definition IDs, require and validate `--mode checkout`, report the new workflow IDs in help/usage, derive current-branch proposal metadata, and retain full-workflow mode and clean-start behavior.
- [x] 3.2 Apply fusion profile parsing, role derivation, preset coverage, and 2–5 distinct planner validation to `fusion-propose` in the CLI start path.
- [x] 3.3 Extend `agentic-coding/test/workflow-cli.test.ts` to cover proposal argument/help validation, worktree-mode rejection, current-branch metadata, dirty-checkout acceptance for proposals, and unchanged validation for other workflows.

## 4. Dashboard workflow surface

- [x] 4.1 Update `agentic-coding/src/tui/dash/engine.ts` to map both proposal IDs, force checkout semantics, derive current-branch proposal startup metadata, and reuse fusion preset/count/profile validation for `fusion-propose`.
- [x] 4.2 Update `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx` with Standard Proposal and Fusion Proposal choices, task-field behavior matching planning workflows, and no worktree-mode picker for proposal choices.
- [x] 4.3 Add dashboard data and routing assertions in `agentic-coding/test/dash/data.test.ts` and relevant dashboard engine/model tests for exact proposal IDs, tasks, checkout semantics, fusion presets, and invalid planner configurations.
- [x] 4.4 Extend `agentic-coding/test/dash/newWorkflowModal.test.tsx` to verify both labels, submitted workflow types, task input, fixed checkout behavior, and regression coverage for existing standard, apply, quick, and plan-fusion paths.

## 5. Documentation and integrated verification

- [x] 5.1 Document `standard-propose` and `fusion-propose` in `README.md` and CLI usage, including current-checkout behavior, no branch/worktree creation or switching, normal OpenSpec artifacts, and the shared-checkout concurrency limitation.
- [x] 5.2 Extend `agentic-coding/test/workflow-plan-fusion.test.ts` with fusion-propose fan-out/consolidation routing, structured draft validation, direct terminal transition, no downstream effects, and same-checkout workspace setup coverage.
- [x] 5.3 Run the repository's workflow registry, runtime/effect, CLI, fusion, and dashboard test suites and fix regressions without changing full-workflow semantics.
- [x] 5.4 Run `bun run type-check` and `bun run lint` from `agentic-coding/`, regenerate generated assets only through the supported build command if required, and confirm the OpenSpec change validates in strict mode.
