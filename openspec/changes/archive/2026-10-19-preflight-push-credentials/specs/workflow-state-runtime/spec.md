## ADDED Requirements

### Requirement: Delivery push credentials are preflighted once, non-interactively

Before a delivery push is attempted, the runner SHALL ask once, with a bounded
deadline and without any possibility of prompting, whether the machine holds a
credential the delivery remote accepts. The preflight SHALL be inside the
existing `delivery.push` handler — no new effect kind, no new step, and no
persisted state change — SHALL report its verdict as an outcome rather than as a
failure of its own, and SHALL never emit or persist credential material. A push
whose preflight established a positive authentication failure SHALL neither be
attempted nor scheduled for another durable attempt.

#### Scenario: The preflight demonstrates an authentication failure

- **WHEN** the delivery remote's push URL refuses the credentials this machine
  holds and the preflight recognizes the refusal
- **THEN** the push SHALL NOT be attempted
- **AND** the delivery effect SHALL be recorded `failed` with a single attempt and
  one attention note naming the remote, its URL, and what to fix
- **AND** no automatic attempt SHALL follow

#### Scenario: The preflight cannot tell

- **WHEN** the preflight times out, cannot reach the host, finds no repository, or
  reports an error it does not recognize as an authentication failure
- **THEN** the push SHALL run exactly as it would without a preflight
- **AND** the inconclusive verdict SHALL be observable and SHALL NOT create
  attention

#### Scenario: There is no credential question to ask

- **WHEN** no delivery remote is configured, the configured remote name does not
  exist in the repository, or the remote is a local path
- **THEN** the preflight SHALL ask nothing and start no subprocess
- **AND** the push SHALL proceed under its normal policy

#### Scenario: The push itself can ask for a credential

- **WHEN** the push runs with an attached interactive credential prompt
- **THEN** the preflight SHALL be skipped rather than decide against a push that
  prompt could have made succeed
- **AND** a push that then fails on authentication SHALL still fail once with the
  same actionable note instead of being retried unchanged

#### Scenario: The credential is fixed and the push is retried

- **WHEN** a delivery push that was blocked is retried through the operator retry
  action after the credential is fixed
- **THEN** the effect SHALL receive a fresh attempt budget and the same push SHALL
  run normally

### Requirement: A delivery block is observable without credential material

The system SHALL report one bounded telemetry event per delivery attempt,
carrying the preflight verdict, whether the block came from the preflight or from
the push itself, and the remote with any credential masked. Neither the event,
the attention note, nor any log line SHALL contain key material, a token, a
passphrase, or unmasked userinfo.

#### Scenario: A blocked delivery is measurable

- **WHEN** a delivery push attempt ends in an authentication block
- **THEN** the event for that block SHALL carry an error outcome, the verdict, and
  its source
- **AND** the reported remote SHALL have any userinfo password masked, and no
  credential SHALL appear in the event or in the note

#### Scenario: An inconclusive check is not reported as a delivery failure

- **WHEN** the preflight cannot tell and the push then succeeds
- **THEN** the event SHALL carry the inconclusive verdict and a non-error outcome
- **AND** the workflow SHALL record no attention for it
