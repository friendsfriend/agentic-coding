# Tasks

## 1. Engine: repair retriggers target step directly

- [x] 1.1 In `agentic-coding/src/workflow/runtime.ts` `repair()`: replace `snapshot.status = 'paused'` with `snapshot.status = 'active'` and call `this.enterStep(db, snapshot, definition)` after rebuilding the target-step state (keep `freshStep(attempt + 1)`, `repaired` metadata, attention clear, stale-run/effect expiry, and `agent.stop` enqueue).
- [x] 1.2 In `agentic-coding/src/workflow/cli.ts`, update the repair usage help text from "Repair to compatible step, paused" to "Repair to compatible step, retriggers phase".

## 2. TUI: single-Enter repair modal

- [x] 2.1 In `agentic-coding/src/tui/dash/App.tsx`, remove the `repairConfirmed` signal and all `setRepairConfirmed` calls; in `repair.handle`'s Enter branch, dispatch `applyRepair` on a single Enter when a target is selected and the reason is non-empty (keep the "Repair reason is required" guard).
- [x] 2.2 In `App.tsx`, update the repair modal title ("ENTER repairs" instead of "ENTER previews"/"ENTER confirms"), the help entry (`Enter` instead of `Enter×2`), and the success message ("Repaired to X: phase retriggered" instead of "…; resume separately").
- [x] 2.3 In `agentic-coding/src/tui/dash/data.ts`, remove the dead `paused` entry from `approvalFor` ("Press Enter to resume repaired workflow").

## 3. Tests

- [x] 3.1 Update `agentic-coding/test/workflow-runtime.test.ts` repair test: after `operator.repair`, status is `active` at the target step (`core.plan-approval`), old run expired, available actions are `['approve-plan', 'reject-plan']` (no `resume`); `operator.resume` with the current revision fails as unavailable; stale-revision dispatch still fails; `approve-plan` at the new revision proceeds to `core.implementation`.
- [x] 3.2 Update `agentic-coding/test/workflow-effects.test.ts`: after repair to `core.implementation` and drain, status is `active`, stale run stopped (`stops === 1`) and fresh successor run launched (`launches === 2`).
- [x] 3.3 Update `agentic-coding/test/workflow-dashboard.test.ts`: `repairWorkflow` returns status `active`; existing stale-revision rejection stays.

## 4. Verification

- [x] 4.1 Run `bun test` and `bun run type-check` in `agentic-coding/`; all pass with no regressions.
- [x] 4.2 Run `openspec validate switch-double-enter-to-single-enter --strict` from `openspec/`; change remains valid.
