# Proposal: Single Enter for repair, repair retriggers phase directly

## Why

Two interaction problems in the workflow dashboard:

1. The repair modal requires **two Enter presses** before it does anything: the first Enter only flips the title from "ENTER previews" to "ENTER confirms", and only the second Enter dispatches the repair. After typing a reason the user must press Enter twice to get a result.
2. After a repair commits, the engine leaves the workflow **paused** and the phase is not retriggered. The dashboard then requires opening the workflow-action picker, selecting "Resume", and confirming it — several more keystrokes — before the repaired phase actually runs. Repair should overwrite the phase and immediately retrigger it.

## What Changes

- In `agentic-coding/src/tui/dash/App.tsx`, the repair modal dispatches on a **single Enter** (with a non-empty reason). The `repairConfirmed` two-step state, the "ENTER previews / ENTER confirms" title, and the `Enter×2` help entry are removed.
- In `agentic-coding/src/workflow/runtime.ts`, `operator.repair` no longer sets `status = 'paused'`. It rebuilds the target-step state and **directly enters the target step** (status `active`, successor runs/effects created immediately), mirroring what `operator.resume` did after repair. The `repaired` metadata, stale-run expiry, and effect expiry stay unchanged.
- `operator.resume` / the `resume` developer action remain for paused workflows that do not originate from repair (legacy migration keeps producing `paused`).
- Success message changes from "Repaired to X; resume separately" to reflect the phase being retriggered; the dead `paused` entry in `approvalFor` (`data.ts`) is removed.
- Tests asserting the old paused-after-repair behavior are updated.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `herdr-workflow-state-control`: repair now produces a fully valid snapshot that directly retriggers the target step; the "explicit resume after repair" requirement is scoped to paused workflows (legacy migration) only.
- `dashboard-engine-integration`: the repair modal dispatches on a single Enter with current revision and reason.

## Impact

- One engine behavior change (`runtime.ts` `repair()`), no schema change; persisted `paused` status remains valid for migrated workflows.
- One TUI interaction change (repair modal) plus message/help text cleanup.
- Three test files updated to assert the new behavior; full `bun test` and `tsc --noEmit` must stay green.
- Out of scope: the workflow-action picker's deliberate confirm stage for committing actions (approve plan, create PR, close, retry effect) is retained.
