## Context

The herdr-workflow system manages a phase-based state machine for OpenSpec-driven implementation changes. It supports modules (plan, apply-verify, archive, git-operations) with defined entry/exit phases. Three features added earlier — stale detection, a recovery agent, and the paused-phase timeout path — have been superseded by `override-phase` and the max-round guard.

## Goals / Non-Goals

**Goals:**

- Remove `cmd_check_timeout` and the `check-timeout` CLI subcommand.
- Remove the recovery agent system: `recovery.py`, `cmd_recover`, `cmd_apply_recovery`, `write_recovery_context`, and their CLI subcommands.
- Remove dashboard code that calls `check-timeout` or loads recovery plans.
- Remove the `recoveryRunId` state field and `recovery-plan.json` file handling.
- Remove `verification_timeout_seconds` config key.
- Remove `RECOVERY_ACTION_PHASES` entries that reference the paused phase.
- Keep the `paused` phase itself (used by the max-verification-round redirect in `cmd_phase`).
- Delete `test_recovery.py` and `CheckTimeoutTest` from `test_phases.py`.
- Update `transition.py` `allowed_transitions` to no longer route through recovery-specific entry points.
- Remove `recover` and `apply-recovery` from the CLI subcommand list and menu.

**Non-Goals:**

- Do NOT remove the `paused` phase from `OPERATIONAL_PHASES`.
- Do NOT change the max-verification-round redirect (`cmd_phase` → `paused`).
- Do NOT migrate existing `recovery-plan.json` or `recoveryRunId` state.
- Do NOT touch any other phase transitions or workflow modules.
- Do NOT add new features to replace removed functionality.

## Decisions

### Decision 1: Delete recovery.py entirely

The module is small (one pure function `recovery_plan_error` with 15 LoC and its `RECOVERY_ACTION_PHASES` constant). It has no other callers. Deleting the file is simpler than keeping a dead module.

### Decision 2: Remove check-timeout CLI, not just the function

The CLI subcommand is the only entry-point for `cmd_check_timeout`. Removing both the function and the argparse entry avoids a dead code path that silently no-ops.

### Decision 3: Keep paused phase, remove only timeout path

The `paused` phase is reached through two paths:
- `cmd_phase` when `fix` is requested at `max_verification_rounds` → keep this.
- `cmd_check_timeout` after timeout → remove only this.

Removing the entire `paused` phase would break the max-round guard. Keeping it also leaves `override-phase` as an escape hatch for any future pause need.

### Decision 4: Do not migrate existing paused workflows

Workflows currently in `paused` phase will remain paused. The `override-phase` command can advance them to any valid phase. No migration code needed.

### Spec Scenarios

1. **Standard workflow never calls check-timeout** — after removing the function and CLI, a workflow in `verify` phase runs to completion or the max-round guard activates. The `paused` phase is only reached through the max-round guard or manual `override-phase`.
2. **Recovery plan file becomes inert** — an existing `recovery-plan.json` on disk is never read by any code path; `recover` and `apply-recovery` CLI commands return "unknown command".
3. **Dashboard no longer triggers timeout check** — `loadDashboard()` does not spawn `check-timeout`. The phase display stays current without the extra subprocess call.
4. **Config key removed** — `verification_timeout_seconds` is removed from `herdr-workflow.toml` and nowhere else references it.
5. **Tests deleted without impact** — `test_recovery.py` is deleted; `CheckTimeoutTest` is removed from `test_phases.py`; remaining phase tests pass unmodified.
