# Spec Delta

## Purpose

Define when a verification round may skip the complete repository test suite,
how that decision is made, recorded, and surfaced, and how a developer can run
the suite for a round that skipped it.

## ADDED Requirements

### Requirement: Per-round suite reduction decision

Each verification round SHALL resolve whether the engine-owned full-suite
verifier role runs. The decision SHALL be derived from a bounded signal about
the round's change, SHALL be recorded on the round, and SHALL default to
running the suite whenever the signal is missing, unusable, or classified with
an error. A round that resolves to skip SHALL still require at least one
non-suite verification signal before it can pass, unless a developer explicitly
accepts the reduced round.

#### Scenario: Behaviour-changing round runs the suite

- **WHEN** the round's change is classified as behaviour-changing
- **THEN** the engine SHALL launch the full-suite verifier role exactly once
- **AND** the round SHALL record that the suite ran

#### Scenario: Documentation-only round skips the suite

- **WHEN** the round's change is classified as documentation or configuration
  only
- **THEN** the engine SHALL NOT launch the full-suite verifier role for that
  round
- **AND** the round SHALL record that the suite was skipped and why

#### Scenario: Unusable signal runs the suite

- **WHEN** the reduction signal is missing, malformed, or the classifier failed
- **THEN** the engine SHALL launch the full-suite verifier role
- **AND** the workflow SHALL record an attention entry

### Requirement: Developer override for a reduced round

A developer SHALL be able to request the complete suite for a round that skipped
it and to accept a reduced round explicitly. Both actions SHALL be recorded, and
a requested suite run SHALL use the same launch path as an automatic one.

#### Scenario: Developer requests the skipped suite

- **WHEN** a developer requests the complete suite for a round that skipped it
- **THEN** the engine SHALL launch the full-suite verifier role for that round
- **AND** the round's record SHALL show the suite as requested rather than
  automatic

#### Scenario: Developer accepts a reduced round

- **WHEN** a developer accepts a round with no verification signal beyond the
  reduction decision
- **THEN** the round SHALL be allowed to pass
- **AND** the acceptance SHALL be recorded on the round

### Requirement: Reduction is visible, never silent

A round whose stages were reduced SHALL be distinguishable in the developer view
and in the workflow record from a round that ran every stage, and the same
record SHALL name the signal that produced the decision.

#### Scenario: Reduced round is reported

- **WHEN** a round completes with a skipped stage
- **THEN** the developer view SHALL show that the stage was skipped and by which
  decision
- **AND** the workflow record SHALL retain that decision for the round
