## 1. Remove check-timeout feature

- [x] 1.1 Delete `cmd_check_timeout` function from `pi/lib/herdr_workflow/commands.py`.
- [x] 1.2 Remove `check-timeout` subcommand from `pi/lib/herdr_workflow/cli.py` subcommand list and the `for name in` loop.
- [x] 1.3 Remove `check-timeout` call from `loadDashboard()` in `agent-dash/src/data.ts` (the `Bun.spawnSync` line).
- [x] 1.4 Remove `verification_timeout_seconds` from `pi/herdr-workflow.toml` config.
- [x] 1.5 Remove `verificationTimeoutRoles` state writes in `cmd_check_timeout` no longer exist; remove any frontend references to `verificationTimeoutRoles` in `agent-dash/src/data.ts` if present.
- [x] 1.6 Remove `CheckTimeoutTest` class from `pi/lib/herdr_workflow/tests/test_phases.py`.

## 2. Remove recovery agent system

- [x] 2.1 Delete `pi/lib/herdr_workflow/recovery.py` entirely.
- [x] 2.2 Remove `cmd_recover` and `cmd_apply_recovery` functions from `pi/lib/herdr_workflow/commands.py`.
- [x] 2.3 Remove `write_recovery_context` helper and its call from `cmd_recover` in commands.py.
- [x] 2.4 Remove recovery telemetry calls (`telemetry(ctx, state, "recovery_started", ...)`, etc.) from commands.py.
- [x] 2.5 Remove `recover` and `apply-recovery` from CLI subcommand list in `pi/lib/herdr_workflow/cli.py`.
- [x] 2.6 Remove `recovery_run_id` import references and `import uuid` from commands.py if `uuid` no longer used.
- [x] 2.7 Remove recovery plan loading and `validRecoveryPlan` function from `agent-dash/src/data.ts` (`loadDashboard` recovery plan section, `recoveryPlan` field).
- [x] 2.8 Remove `RECOVERY_ACTION_PHASES` from `recovery.py` — entire file is deleted, no standalone cleanup needed.
- [x] 2.9 Delete `pi/lib/herdr_workflow/tests/test_recovery.py`.

## 3. Remove dashboard recovery UI references

- [x] 3.1 Remove `recoveryPlan` from `DashboardData` interface in `agent-dash/src/data.ts`.
- [x] 3.2 Remove `recoveryRunId` from `WorkflowState` interface if present.
- [x] 3.3 Remove recovery-plan file reads from `loadDashboard()` return value.
- [x] 3.4 Verify dashboard components referencing `recoveryPlan` are updated or removed.

## 4. Update transitions

- [x] 4.1 No changes needed to `OPERATIONAL_PHASES` — keep `paused`.
- [x] 4.2 No changes needed to `allowed_transitions` — the `verify → paused` edge is only reachable through `cmd_check_timeout` (deleted) and `cmd_phase` redirect (kept).
- [x] 4.3 No changes needed to `WORKFLOW_MODULES["apply-verify"]["phases"]` — keep `paused` in set.

## 5. Validation

- [x] 5.1 Run project tests: `pi/lib/herdr_workflow/tests/` — ensure all tests pass after deletions.
- [x] 5.2 Run `herdr-workflow --help` to confirm removed subcommands no longer appear.
- [x] 5.3 Build or type-check `agent-dash` (`cd agent-dash && bun run build`) to catch any unreferenced recovery symbols.
- [x] 5.4 Grep for `check.timeout\|cmd_recover\|cmd_apply_recovery\|recovery_plan\|recoveryRunId` in remaining code to confirm no dangling references.
