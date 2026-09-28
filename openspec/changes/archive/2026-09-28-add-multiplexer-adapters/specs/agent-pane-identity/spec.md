# Spec Delta

## MODIFIED Requirements

### Requirement: Deterministic unique agent names
Each workflow-managed agent SHALL have one canonical name derived from its workflow change ID, step, and role (plus round discriminator for grouped one-shot roles). The derivation SHALL be injective within the selected multiplexer runtime: two different workflows, steps, or roles SHALL never map to the same live agent name. The discriminating identity (change + role) SHALL NOT be truncated away to satisfy runtime name limits; when the selected runtime cannot accept the canonical name, the launch SHALL fail with a bounded diagnostic naming the limit instead of truncating or renaming the identity.

#### Scenario: Long change IDs do not collide
- **WHEN** two workflows run for change IDs that share the same leading characters up to any legacy truncation width
- **THEN** their persistent-role agents SHALL still receive distinct canonical names and SHALL never resolve to each other's panes

#### Scenario: Name derivation is stable across restarts
- **WHEN** the engine re-derives an agent's canonical name after a restart or retry
- **THEN** the same workflow, step, role, and round SHALL produce the identical name as before

#### Scenario: Selected runtime rejects the canonical name
- **WHEN** the selected multiplexer enforces a name limit or character set the canonical name cannot satisfy
- **THEN** the launch SHALL fail with a bounded diagnostic naming the constraint
- **AND** the identity SHALL NOT be silently truncated into a possible collision
