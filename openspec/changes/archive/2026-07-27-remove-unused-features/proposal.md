## Why

Three features were added speculatively and never earned their keep:

1. **Stale detection + auto-pause** — The `check-timeout` command periodically checks whether verification roles exceeded `verification_timeout_seconds`. If so, it transitions to `paused`. In practice, timeouts are better handled by `override-phase` or the max-round redirect. The auto-pause surprises operators more than it helps.
2. **Recovery agent** — A separate Pi agent (`cmd_recover`) analyzes failure context and produces a `recovery-plan.json`. The dashboard reads this plan and offers retry/dispatch/record actions. The `override-phase` command already covers manual phase recovery with less ceremony and one less agent launch.
3. **Paused phase stale-path** — The `verify → paused` transition through `cmd_check_timeout` is the only stale-triggered path. The `paused` phase itself stays (used by the max-verification-round guard in `cmd_phase`). Only the timeout-driven entry is removed.

## What Changes

- **BREAKING** Remove `cmd_check_timeout`, the `check-timeout` CLI subcommand, and its dashboard trigger in `loadDashboard()`.
- **BREAKING** Delete `recovery.py`, `cmd_recover`, `cmd_apply_recovery`, `write_recovery_context`, `recover`/`apply-recovery` CLI subcommands, and all dashboard recovery-plan loading code.
- **BREAKING** Delete `test_recovery.py`. Remove `CheckTimeoutTest` from `test_phases.py`.
- Remove `RECOVERY_ACTION_PHASES` entries that reference the paused phase.
- Keep the `paused` phase in `OPERATIONAL_PHASES` (used for max-round guard in `cmd_phase`).
- Remove `recoveryRunId` and `recovery-plan.json` from state/dashboard surface.
- Remove `verification_timeout_seconds` from config (was only used by `cmd_check_timeout`).

## Capabilities

### Removed Capabilities

- `herdr-workflow-check-timeout`: Auto-detect stale verification roles and pause the workflow.
- `herdr-workflow-recover`: Launch a recovery agent and apply its plan.
- `herdr-workflow-apply-recovery`: Execute a stored recovery plan.
- `recovery-plan-ui`: Dashboard recovery-plan display and approval flow.

## Impact

- Affected files: `pi/lib/herdr_workflow/commands.py`, `pi/lib/herdr_workflow/cli.py`, `pi/lib/herdr_workflow/recovery.py`, `pi/lib/herdr_workflow/tests/test_recovery.py`, `pi/lib/herdr_workflow/tests/test_phases.py`, `agent-dash/src/data.ts`, `pi/herdr-workflow.toml`.
- No new runtime dependencies.
- Existing workflows in `paused` phase remain paused; state is not migrated. `override-phase` can advance them.
- Recovery plans on disk become inert (no code reads them anymore).
