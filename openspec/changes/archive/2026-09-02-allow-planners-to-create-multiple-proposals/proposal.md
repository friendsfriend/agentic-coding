## Why

Today a workflow is started with a user-supplied change id that becomes the workflow's identity and the single OpenSpec change every downstream step operates on. This forces the planner to cram all requested work into one change (or silently plan only the first slice), because the change scope is fixed before planning even runs. Letting the planner decide change scope — including splitting work into a primary change plus well-scoped follow-up proposals — produces better-sized changes.

## What Changes

- **BREAKING** `agentic-coding workflow start` accepts a user-supplied **workflow id** instead of a change id, and every addressing verb (`status`, `action`, `handoff` context, `question` context, `repair`, `repin`, `resume`) addresses a running workflow by that workflow id rather than by change id.
- The workflow store is keyed by the user-supplied **workflow id** (the branch prefix and canonical-store row identity move to it) instead of the change id.
- `metadata.changeId` is no longer supplied at start. It is empty until the **planner** creates one or more OpenSpec changes, designates exactly one as the **primary** change for this workflow, and declares that primary change id in its planning handoff output; the engine records it into `metadata.changeId` for all downstream steps.
- The planner MAY author additional, independently valid follow-up OpenSpec change directories (each with its own proposal/design/tasks/specs) alongside the primary change. This workflow only implements the primary change; follow-up proposals are left in `openspec/changes/` as drafts for a human to promote into their own workflows later.
- The planning entry-guard validates the planner-declared **primary** change directory (proposal/design/tasks + at least one scenario) instead of a start-time change id, and rejects a handoff that declares no primary change or names a primary directory that does not exist.
- The planner assignment (`instructions/planning.md`, `instructions/planning-fusion.md`, `instructions/fusion-consolidation.md`) is rewritten to reference `$HERDR_WORKFLOW_ID` for identity, instruct the planner to choose change id(s), author a primary change plus optional follow-up proposals, and declare the primary change id at handoff. `HERDR_CHANGE_ID` is only exported to steps that run after the primary change is recorded.

## Capabilities

### New Capabilities
- `planner-change-authoring`: The planner defines OpenSpec change id(s), authors a primary change plus optional independently-valid follow-up proposal drafts, and declares the primary change id at planning handoff; the engine records the primary and the planning entry-guard validates it.

### Modified Capabilities
- `workflow-engine-runtime`: The engine binary surface addresses running workflows by a user-supplied workflow id; `start` takes the workflow id (not a change id), and `start`/`status`/`action` and other addressing verbs are described in terms of workflow id.
- `workflow-state-runtime`: The single canonical workflow store is keyed by the user-supplied workflow id; `changeId` is populated by the planner during the plan step rather than required at workflow start, and run-bound artifact validation targets the planner-declared primary change.

## Impact

- `src/workflow/cli/commands/start.ts` — accept `--workflow-id`, drop start-time change id, derive branch from workflow id.
- `src/workflow/runtime/engine.ts` — `start()` validates workflow id, keys `workflow_instances` by workflow id, seeds empty `metadata.changeId`; the plan handoff records the declared primary change id into metadata.
- `src/workflow/runtime/targets.ts` — rename/repurpose `validateChangeId` to validate the user-supplied workflow id (and add change-id validation for planner-declared ids).
- `src/workflow/runtime/store.ts` / `view.ts` — key lookups and views by workflow id.
- `src/workflow/steps/planning.ts` + `src/workflow/steps/validation.ts` — plan output contract carries the declared primary change id; `validatePlanningArtifacts` validates the declared primary directory.
- `src/workflow/effect-runner.ts` — `HERDR_CHANGE_ID` injection only for post-plan steps; openspec validate/apply/archive/commit use the recorded primary change id.
- `src/workflow/contracts.ts` — plan output contract and any metadata schema/parse changes.
- `agent-definitions/instructions/planning.md`, `planning-fusion.md`, `fusion-consolidation.md`, `archive.md` — prompt rewrite; `src/workflow/embedded.generated.ts` regenerated via `bun run build`.
- Existing CLI callers, docs, and any `--change` addressing in `src/tui/` dashboards.
