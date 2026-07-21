## ADDED Requirements

### Requirement: Verifier completion command contract
The Herdr verifier skills SHALL signal their verdict to the workflow using the exact `verification-result` command accepted by `herdr-workflow`, which reads the verdict from the mandatory final JSONL verdict line and accepts no verdict flag.

#### Scenario: Verifier signals result with only supported flags
- **GIVEN** a Herdr verifier (`security-verifier`, `agents-verifier`, `quality-verifier`, `performance-verifier`, `openspec-verifier`, or `test-verifier`) that has written its `round-N-<role>.findings.jsonl` ending in a `{"type":"verdict","verdict":"PASS"|"FAIL"}` line
- **WHEN** the verifier signals completion
- **THEN** it SHALL run `herdr-workflow verification-result --repo "$PWD" --change "$HERDR_CHANGE_ID" --role <role>`
- **AND** the command SHALL NOT include a `--verdict` flag
- **AND** the command SHALL exit successfully so `cmd_verification_result` records the verdict and advances the workflow out of `verify`

#### Scenario: Unknown flag would stall verification
- **GIVEN** the `verification-result` argument parser declares only `--repo`, `--change`, and `--role`
- **WHEN** a verifier skill instructs the agent to pass an unsupported flag such as `--verdict`
- **THEN** the command SHALL be treated as a defect because argparse rejects the unknown flag, the verdict is never recorded, and the workflow remains stuck in `verify` until the timeout watchdog forces `paused`
- **AND** every verifier skill SHALL therefore use only the supported flags

#### Scenario: Verifier skills share one identical completion command
- **GIVEN** the six verifier skill documents
- **WHEN** each defines its completion step
- **THEN** the only difference between them SHALL be the `--role` value
- **AND** none SHALL include a `--verdict` flag
