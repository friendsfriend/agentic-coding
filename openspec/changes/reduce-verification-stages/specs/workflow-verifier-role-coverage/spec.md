# Spec Delta

## MODIFIED Requirements

### Requirement: Complete-suite ownership remains with the test verifier

After every selected verifier run for a round reports, the workflow SHALL launch `test-verifier` exactly once if the complete test suite has not already run in that round and the round has not resolved a recorded reduction decision that skips the suite, regardless of whether `test-quality-verifier` was selected.

#### Scenario: Selected verifiers pass without the test verifier
- **WHEN** all selected verifier runs report no critical finding and the complete suite has not run in the round
- **THEN** the workflow SHALL launch `test-verifier` before the round can pass
- **AND** the round SHALL NOT pass until that run reports

#### Scenario: Test quality verifier does not replace the test verifier
- **WHEN** `test-quality-verifier` is selected and reports no critical finding
- **THEN** the workflow SHALL still launch `test-verifier` once for the round

#### Scenario: Suite already ran in the round
- **WHEN** the complete suite has already run in the round
- **THEN** the workflow SHALL NOT launch `test-verifier` a second time

#### Scenario: Round reduces the suite
- **WHEN** the round recorded a reduction decision that skips the complete suite
- **THEN** the workflow SHALL NOT launch `test-verifier` for that round
- **AND** the reduction decision SHALL be retained on the round
