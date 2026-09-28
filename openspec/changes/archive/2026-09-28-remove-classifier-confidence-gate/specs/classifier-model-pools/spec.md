## RENAMED Requirements

- FROM: `### Requirement: Single-select choice with confidence gate`
- TO: `### Requirement: Single-select choice uses the classifier's most probable entry`

## MODIFIED Requirements

### Requirement: Single-select choice uses the classifier's most probable entry

For a `single` step the classifier SHALL ask a TypeSafe `choice` question whose
criteria are the pool entries' criteria, and the router SHALL apply the entry the
classifier named in the answer's `choice` regardless of the answer's
`confidence`. `confidence` SHALL be retained on the recorded answer and in
routing telemetry, but SHALL NOT influence which entry is applied. When the
answer names no entry, or names an entry that is not in the pool, the router
SHALL select the offered entry with the highest `probabilities` value. Only when
the answer carries neither a `choice` naming an offered entry nor probabilities
for offered entries SHALL the pool's tagged `default: true` entry be applied and
`attention` recorded.

#### Scenario: Low-confidence choice is applied

- **WHEN** a single-select answer names a pool entry with `confidence` below 0.5
- **THEN** that entry's profile SHALL be applied to the step's routes
- **AND** no fallback SHALL be recorded

#### Scenario: Confidence is not consulted

- **WHEN** a single-select answer names a pool entry and carries a confidence above, at, or below 0.5
- **THEN** the named entry SHALL be applied in every case

#### Scenario: Probabilities-only answer uses the most probable entry

- **WHEN** a single-select answer carries no `choice` naming an offered entry but carries `probabilities` for offered entries
- **THEN** the offered entry with the highest probability SHALL be applied to the step's routes

#### Scenario: An unknown label falls back to the most probable entry

- **WHEN** a single-select answer names a `choice` that is not in the pool but carries probabilities for offered entries
- **THEN** the offered entry with the highest probability SHALL be applied

#### Scenario: Unusable answer falls back to the tagged default

- **WHEN** a single-select answer carries neither a `choice` naming an offered entry nor probabilities for offered entries
- **THEN** the pool's `default: true` entry SHALL be applied
- **AND** the workflow SHALL record `attention`
