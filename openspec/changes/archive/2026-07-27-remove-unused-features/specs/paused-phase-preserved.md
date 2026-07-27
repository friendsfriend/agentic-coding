# Spec: paused phase preserved for max-round guard

## Scenario

A workflow reaches `verificationRound === max_verification_rounds` and requests `phase fix`. `cmd_phase` detects the limit and redirects to `paused` instead.

## Expected behavior

1. `paused` remains in `OPERATIONAL_PHASES`.
2. `paused` remains in `WORKFLOW_MODULES["apply-verify"]["phases"]`.
3. `paused` remains in `allowed_transitions(state)` (verify ↔ paused, paused ↔ fix).
4. `cmd_phase` still redirects `fix → paused` at max rounds.
5. `override-phase paused` still works.
6. Only the `verify → paused` transition through `cmd_check_timeout` is gone.

## Impact

- Existing workflows in `paused` phase remain valid.
- Max-round guard behavior unchanged.
