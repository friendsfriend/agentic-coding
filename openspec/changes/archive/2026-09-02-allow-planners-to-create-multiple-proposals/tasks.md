## 1. Identity: user-supplied workflow id at start

- [x] 1.1 In `src/workflow/runtime/targets.ts`, add/repurpose validation so the user-supplied workflow id is validated at start and add a change-id validator for planner-declared ids; verify with a focused unit test asserting valid/invalid workflow-id and change-id shapes are accepted/rejected.
- [x] 1.2 In `src/workflow/cli/commands/start.ts`, accept `--workflow-id` (replace `--change`), drop the start-time change id, derive the branch from the workflow id, and pass the workflow id as the store key; verify by starting a workflow with only `--workflow-id` and confirming `status --workflow-id <id>` returns the started workflow.
- [x] 1.3 In `src/workflow/runtime/engine.ts` `start()`, key `workflow_instances` on the user-supplied workflow id, seed `metadata.changeId` empty, and move the `already-exists` guard to the workflow-id key; verify with a focused engine test that starting two workflows with the same workflow id fails `already-exists` and that a fresh start has empty `metadata.changeId`.
- [x] 1.4 In `src/workflow/runtime/store.ts` and `src/workflow/runtime/view.ts`, resolve/lookup rows and build views by workflow id; verify with the focused store/view test that a row is readable by workflow id and the view reports the workflow id and empty change id pre-plan.

## 2. Addressing verbs by workflow id

- [x] 2.1 Update `status`, `action`, `repair`, `repin`, `resume`, and question/handoff context resolution to address workflows by `--workflow-id`; verify with focused CLI/engine tests that each verb resolves the correct workflow by id and rejects an unknown id without mutation.
- [x] 2.2 Update `src/tui/` dashboard call sites that address workflows by change id to use the workflow id; verify the dashboard opens a started workflow and its status view shows the workflow id (focused component/integration test or documented manual check).

## 3. Planner declares the primary change

- [x] 3.1 In `src/workflow/contracts.ts` and the `core.plan` output contract, add a required `primaryChangeId` field to the plan output schema; verify with a focused contract test that a plan output missing `primaryChangeId` is rejected and a valid one parses.
- [x] 3.2 In `src/workflow/steps/planning.ts` (+ `steps/validation.ts`), record the declared `primaryChangeId` into `metadata.changeId` on plan completion and make `validatePlanningArtifacts` validate the declared primary change directory (proposal/design/tasks + ≥1 scenario); verify with focused tests that a valid primary is recorded and advances, and a missing/incomplete/undeclared primary is rejected without recording or advancing.
- [x] 3.3 Ensure the fusion consolidation completion path records the primary change id the same way; verify with a focused test that `fusion.consolidate` completion records `metadata.changeId` from the declared primary.

## 4. Downstream env and effects

- [x] 4.1 In `src/workflow/effect-runner.ts`, omit `HERDR_CHANGE_ID` while `metadata.changeId` is empty and inject it (from the recorded primary) for steps after plan; keep the agent-name digest seeded from the workflow id; verify with a focused effect-runner test that a plan-step assignment has no `HERDR_CHANGE_ID` and an implementation-step assignment has `HERDR_CHANGE_ID` equal to the recorded primary.
- [x] 4.2 Confirm openspec `validate`/`apply`/`archive`/commit in the effect-runner use `metadata.changeId` (the recorded primary) unchanged; verify with a focused test asserting these calls reference the recorded primary change id.

## 5. Planner assignment prompts

- [x] 5.1 Rewrite `agent-definitions/instructions/planning.md`, `planning-fusion.md`, and `fusion-consolidation.md` to reference `$HERDR_WORKFLOW_ID` for identity, instruct the planner to choose change id(s), author a primary change plus optional independently-valid follow-up proposals, and declare the primary change id at handoff; verify by reading the rendered assignment for `core.plan` and confirming it no longer relies on a pre-existing `$HERDR_CHANGE_ID`.
- [x] 5.2 Update `agent-definitions/instructions/archive.md` (and any other post-plan instruction) if its `$HERDR_CHANGE_ID` usage assumptions changed; verify the archive assignment still receives `HERDR_CHANGE_ID` equal to the recorded primary.
- [x] 5.3 Regenerate `src/workflow/embedded.generated.ts` with `bun run build`; verify the generated planning/consolidation strings match the updated instruction files.

## 6. Consistency checks

- [x] 6.1 Run `bun run type-check`, `bun run lint`, and the focused workflow test files touched above (steps, store/view, engine, effect-runner, contracts) and confirm zero diagnostics and passing focused tests.
- [x] 6.2 Grep `src/workflow/` and `src/tui/` and `docs/` for remaining start-time/addressing uses of `--change`/change-id-as-identity and confirm each is either converted to workflow id or is a legitimately change-scoped (post-plan) reference; record the audit result.
