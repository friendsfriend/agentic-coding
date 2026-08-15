# Design: Single Enter for repair, repair retriggers phase directly

## Context

`agentic-coding/src/tui/dash/App.tsx` opens the repair modal on `Shift+O`. Its keymap layer `repair.handle` implements a two-step Enter flow: the first Enter press validates that a target is selected and the reason is non-empty, then only sets `repairConfirmed(true)` (title flips from "ENTER previews" to "ENTER confirms"); a second Enter press dispatches `applyRepair` and shows "Repaired to X; resume separately". The modal help literally reads `Enter×2`.

`agentic-coding/src/workflow/runtime.ts` `repair()` commits the target step with `snapshot.status = 'paused'`. A paused workflow only offers the `resume` action (`actions()` returns `[{ id: 'resume', confirmation: 'confirm' }]` for paused status), so the dashboard gate opens the workflow-action picker, where selecting Resume and confirming it needs two more Enters. The engine already contains the exact retrigger logic needed: `operator.resume` sets `status = 'active'`, clears attention, and calls `this.enterStep(db, snapshot, definition)`, which runs the step's enter reduction and creates successor runs/effects (for agent steps: fresh `artifact.write` + `agent.launch`).

Paused status can still legitimately exist: legacy migration maps `phase === 'paused'` to `status = 'paused'` at `core.implementation`. So `resume` must be kept, only repair stops producing paused workflows.

## Goals / Non-Goals

**Goals:**
- Repair dispatches on a single Enter press when a target is selected and the reason is non-empty.
- Repair overwrites the phase and directly retriggers it (successor runs/effects start immediately, no paused state).
- Keep `resume` working for paused workflows that do not originate from repair.
- Update tests to assert the new behavior.

**Non-Goals:**
- Removing the confirmation stage in the workflow-action picker ("Press Enter again to confirm") for committing actions such as approve-plan, create-pr, close, retry-effect. That is a deliberate safety confirmation for committing actions and is untouched.
- Changing repair target legality, preview, stale-run/effect expiry, `repaired` metadata, or the repair CLI command surface.
- Schema or contract changes: `WorkflowStatus` and the `operator.resume` command remain.

## Decisions

### D1: Repair modal dispatches on a single Enter

In `repair.handle`, the Enter branch becomes: if no target is selected or the reason is empty, show "Repair reason is required"; otherwise dispatch `applyRepair` immediately, close the modal, and refresh. Delete the `repairConfirmed` signal and every `setRepairConfirmed` call (open, j/k navigation, backspace, typing, space, and the Enter branch). Update the modal title to a static "ENTER repairs" suffix and the help entry from `Enter×2 · Confirm` to `Enter · Repair`.

The success message changes from `Repaired to ${target.label}; resume separately` to `Repaired to ${target.label}: phase retriggered`.

### D2: Repair enters the target step directly instead of pausing

In `runtime.ts` `repair()`, replace `snapshot.status = 'paused'` with `snapshot.status = 'active'` and call `this.enterStep(db, snapshot, definition)` after rebuilding the target-step state. This is exactly the resume body, so the retrigger path is shared and proven:

- `snapshot.currentStep = command.targetStep`, `stepEnteredAt` refreshed, `step = freshStep(step.attempt + 1)` (fresh generation for successor runs), `repaired` metadata recorded, attention cleared.
- `enterStep` runs the target step's enter reduction and, for agent steps, creates successor runs with fresh `artifact.write`/`agent.launch` effects; for developer steps (e.g. `core.plan-approval`) the workflow becomes active awaiting its actions (approve/reject).
- Stale runs are still expired and `agent.stop` is still enqueued for handled runs before retriggering.

`operator.resume` (`runtime.ts` reduce) and `developer.action 'resume'` are retained unchanged; they remain the only way to leave a paused workflow, which after this change originates only from legacy migration.

### D3: TUI cleanup for the removed pause path

- `data.ts` `approvalFor`: remove the `paused` entry ("Press Enter to resume repaired workflow"). It is unreachable in engine mode (the gate receives a step id, never `"paused"`) and now misleading.
- `App.tsx` status prompt (`data().state.status === "paused" ? "Verification paused · developer intervention required" : ...`) stays: migrated paused workflows still exist.
- `cli.ts` usage text `repair  Repair to compatible step, paused` → `repair  Repair to compatible step, retriggers phase`.

### D4: Tests assert retrigger, not pause

- `test/workflow-runtime.test.ts` ("developer CAS and repair invalidate runs and require explicit resume"): after `operator.repair` to `core.plan-approval`, assert status `active`, current step `core.plan-approval`, old run expired, available actions are `['approve-plan', 'reject-plan']` (no `resume`); `operator.resume` with current revision fails as unavailable (workflow not paused); stale-revision dispatch still fails; then `approve-plan` at the new revision proceeds to `core.implementation`.
- `test/workflow-effects.test.ts`: after repair to `core.implementation` and a drain, assert status `active`, stale run stopped (`adapter.stops === 1`) and a fresh successor run launched (`adapter.launches === 2`).
- `test/workflow-dashboard.test.ts`: `repairWorkflow(...)` returns status `active`; the stale-revision resume rejection stays valid (repair already advanced the revision).

## Verification

- `cd agentic-coding && bun test` and `bun run type-check` pass.
- `openspec validate switch-double-enter-to-single-enter --strict` passes (from `/home/archgamer/agentic-coding/openspec`).

## Risks

- Medium: tests encode the old paused contract and must be updated in the same change; missed assertions fail loudly since repair's view status and available actions change.
- Low: some paused workflows from before this change exist in real stores; they remain resumable through the retained resume action.
- Low: single-Enter repair removes the preview step, so a mis-typed reason applies immediately. The modal still requires a non-empty reason and shows the target, revision, and affected runs before dispatch; this matches the explicit user request.
