# Spec: recovery system removed

## Scenario

A workflow in `fix` phase encounters an error. `override-phase` exists to manually set any phase. Previously, `recover` would launch a recovery agent; `apply-recovery` would execute the plan. After removal, neither command is available.

## Expected behavior

1. `herdr-workflow recover --repo ... --change ...` → "unknown command" or argparse error.
2. `herdr-workflow apply-recovery --repo ... --change ...` → "unknown command" or argparse error.
3. Existing `recovery-plan.json` files on disk are never read by any code path.
4. `loadDashboard()` does not include `recoveryPlan` in its return value.
5. `recovery.py` file does not exist.
6. `test_recovery.py` does not exist.

## Impact

- Phase recovery is still possible via `override-phase` (manual) or `phase` (allowed transitions).
- Recovery plans on disk in existing worktrees become inert. No migration needed.
