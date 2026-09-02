## Context

See proposal.md - Why. Today `agentic-coding workflow start` takes a user-supplied change id that becomes both the workflow's store key and the single OpenSpec change every step operates on. Key facts from the current engine:

- `snapshot.workflowId` already exists but is an internal `randomUUID()`; `snapshot.metadata.changeId` is the user-supplied value and the real identity: `workflow_instances` is keyed on `change_id` (`runtime/store.ts`, `runtime/engine.ts` `start()`'s duplicate check `WHERE change_id=?`), the branch is `${branch_prefix}${change}` (`cli/commands/start.ts`), and the effect-runner agent-name digest is seeded from `changeId` (`effect-runner.ts`).
- `metadata.changeId` drives every downstream step: plan/impl/archive entry-guards (`steps/validation.ts`), and openspec `validate`/`apply`/`archive`/commit plus `HERDR_CHANGE_ID` injection (`effect-runner.ts` ~line 1423, `HERDR_CHANGE_ID: snapshot.metadata.changeId`).
- `validateChangeId` lives in `runtime/targets.ts`; the plan entry-guard `validatePlanningArtifacts` reads `openspec/changes/<changeId>/`.
- Status/action/repair CLI verbs address a workflow by `--change`; `WorkflowView.workflowId` is already surfaced in the read model.

## Goals / Non-Goals

**Goals:**
- The user supplies a workflow id at start; the planner chooses the change id(s).
- The workflow implements one planner-declared primary change; the planner may also leave follow-up proposal drafts.
- Downstream steps (implementation → verification → archive → delivery) are unchanged in shape — they read the recorded primary change id exactly where they read `metadata.changeId` today.

**Non-Goals:**
- No multi-change pipeline: this workflow never implements, verifies, or archives more than the primary change. Follow-up drafts are handed off to humans, not driven by this workflow (per developer direction).
- No change to the fusion fan-out's parallel-planner semantics beyond identity/prompt updates.
- No migration of already-running workflows to the new keying beyond what the existing legacy-migration path already covers.

## Decisions

### D1: Repurpose the user-supplied value as the workflow id; make `changeId` planner-owned
`workflow start` accepts `--workflow-id` (replacing `--change`). The store row, branch prefix, and effect-runner agent-name seed key on the workflow id. `metadata.changeId` starts empty and is filled when the plan step records the planner's declared primary.

*Alternative considered:* keep `change` as the CLI flag name and just treat it as the workflow id internally. Rejected — the developer explicitly wants the user-facing concept to be a workflow id, and keeping the old flag name would mislead callers and docs.

### D2: Planner declares the primary change id via its plan handoff output
The `core.plan` output contract gains a required `primaryChangeId` field. On plan completion the engine validates the id shape (reuse the change-id validator) and that `openspec/changes/<primaryChangeId>/` is a complete change directory, then records it into `metadata.changeId`. `validatePlanningArtifacts` validates the declared primary directory instead of `metadata.changeId` (which is empty until this point).

*Alternative considered:* infer the primary change by scanning `openspec/changes/` for the newest/only directory. Rejected — ambiguous when the planner authors follow-ups; an explicit declaration is unambiguous and auditable, and the engine "SHALL NOT infer outcome from file existence alone" (workflow-state-runtime).

### D3: `HERDR_CHANGE_ID` is injected only after the primary is recorded
The plan/plan-fusion/consolidation assignments reference `$HERDR_WORKFLOW_ID` for identity and instruct the planner to create change directory(ies) with its own chosen id(s) and `--description`. `HERDR_CHANGE_ID` is exported only to steps that run after `metadata.changeId` is set (implementation onward, archive). The effect-runner omits `HERDR_CHANGE_ID` when `metadata.changeId` is empty.

*Alternative considered:* always export `HERDR_CHANGE_ID`, empty during plan. Rejected — an empty env var invites the planner to `openspec new change ""`; absence + explicit prompt guidance is clearer.

### D4: Follow-up proposals are ordinary, independently-valid change directories
The planner authors each follow-up as a normal `openspec/changes/<id>/` with its own proposal/design/tasks/specs. No engine tracking is added for them; they are drafts a human promotes into their own workflow later. Downstream steps only ever touch the recorded primary change, so follow-ups are inert.

## Risks / Trade-offs

- **[Breaking CLI change]** Existing scripts/docs using `--change` at start and for addressing break. → Update all in-repo callers, dashboards (`src/tui/`), and docs in this change; the proposal marks it BREAKING. In-flight workflows keep their recorded `changeId`; only start/addressing input changes.
- **[Planner authors follow-ups that never get promoted]** Drafts could accumulate unpromoted in `openspec/changes/`. → Out of scope to auto-manage; the plan prompt frames follow-ups as explicit human handoffs, and they are valid change dirs a human can start or delete.
- **[Primary change directory incomplete at handoff]** Planner declares a primary whose artifacts are incomplete. → The plan entry-guard already validates proposal/design/tasks + ≥1 scenario; it now runs against the declared primary and rejects on failure, consuming no capability.
- **[Duplicate workflow id]** Two workflows started with the same user-supplied id. → The `already-exists` check moves from `change_id` to the workflow-id key, preserving the same guard semantics.
- **[Effect-runner agent-name collisions]** The name digest reseeds from workflow id instead of change id. → Workflow id is unique per store row (it is the key), so injectivity is preserved or improved.

## Migration Plan

- New workflows use the new start surface immediately; the store schema column `change_id` is retained but now populated at plan time (empty until then). If a schema/keying change to `workflow_instances` is required, prefer keying on the existing workflow-id column and keep `change_id` as a recorded, initially-empty field to avoid a destructive migration.
- Rollback: revert the change; already-recorded `changeId` values remain valid because downstream steps read `metadata.changeId` unchanged.

## Open Questions

- Whether `workflow_instances` should be re-keyed by adding/using a workflow-id primary key column or by renaming the existing `change_id` column semantics is an implementation detail for the worker to resolve against `runtime/store.ts`'s schema, provided the observable behavior (row keyed by workflow id, `changeId` recorded at plan time) holds. This does not change the specs or task breakdown.
