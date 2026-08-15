# credentials-popup Specification

## Purpose
On-demand, masked credential popup for engine-run git commands — surfaced only when ssh/git actually requests an SSH passphrase — plus new-workflow wizard cleanups (no passphrase step, no Agent routing summary row).

## Requirements

### Requirement: On-demand SSH passphrase popup
When an engine-run git command requests an SSH passphrase, the dashboard SHALL show a masked credential popup on demand and feed the entered passphrase to the running command so the workflow continues without restart.

#### Scenario: Push requires a passphrase
- **GIVEN** a delivery push whose SSH key is passphrase-protected and not unlocked in an agent
- **WHEN** the push requests a passphrase
- **THEN** the dashboard SHALL show a masked popup with the verbatim prompt text
- **AND** the entered passphrase SHALL be delivered to the running push
- **AND** the workflow SHALL continue without restarting the push

#### Scenario: No credential required
- **WHEN** an engine-run git command completes without requesting any credential
- **THEN** no popup SHALL appear
- **AND** the command result SHALL be unchanged

#### Scenario: Popup cancelled
- **WHEN** the user cancels the credential popup or submits an empty answer
- **THEN** the command SHALL fail with its original error instead of hanging
- **AND** the existing effect retry policy SHALL apply

### Requirement: Non-interactive fail-fast
When an engine git command requests a credential in a context without an interactive popup, the command SHALL fail immediately with an actionable diagnostic naming the requested credential.

#### Scenario: CLI context
- **WHEN** a credential request occurs while effects drain without a dashboard attached
- **THEN** the effect SHALL fail with a diagnostic that includes the prompt text and suggests unlocking the key
- **AND** it SHALL not hang

### Requirement: New workflow wizard without credential or routing summary
The new-workflow wizard SHALL NOT include a passphrase or credential input step, and SHALL NOT show an Agent routing row in its confirm summary.

#### Scenario: Wizard fields and summary
- **WHEN** the new-workflow modal is opened
- **THEN** its steps SHALL NOT include a passphrase or credential field
- **AND** its confirm summary SHALL NOT include an Agent routing row
