# Spec: check-timeout removed

## Scenario

A workflow in `verify` phase has one role (`quality-verifier`) that has been running for 900 seconds. `verification_timeout_seconds` is 600. Previously, `cmd_check_timeout` would detect this and transition to `paused`. After the removal, no automatic timeout check runs.

## Expected behavior

1. `herdr-workflow check-timeout --repo ... --change ...` returns "unknown command" or argparse error.
2. The workflow stays in `verify` phase until all roles complete, the max-round guard activates, or `override-phase` is used.
3. `loadDashboard()` does not spawn a `check-timeout` subprocess.
4. `verification_timeout_seconds` key does not exist in `herdr-workflow.toml`.

## Impact

- Pre-existing workflows in `verify` phase are not affected: they complete naturally.
- Pre-existing workflows in `paused` phase (set by a prior timeout) remain paused. `override-phase` advances them.
