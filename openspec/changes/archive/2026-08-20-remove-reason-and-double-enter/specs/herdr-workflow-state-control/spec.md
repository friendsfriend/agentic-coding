## MODIFIED Requirements

### Requirement: Validated workflow repair
The system SHALL let developer repair active workflow to registered target step only through a revision-checked command, with an optional reason, expiring incompatible run capabilities, rebuilding target-step state, validating all invariants, and directly retriggering the target step without an intermediate paused state.

#### Scenario: Developer previews repair
- **WHEN** dashboard opens repair for active workflow
- **THEN** engine SHALL return only target steps compatible with pinned definition and current durable evidence
- **AND** preview SHALL identify runs/evidence that repair would expire or retain

#### Scenario: Developer confirms repair
- **WHEN** developer confirms target with current revision, with or without a reason
- **THEN** engine SHALL expire incompatible run capabilities, rebuild target-step state, validate all invariants, commit repair event, and enter the target step directly so successor runs/effects start immediately
- **AND** repair SHALL NOT pause the workflow or require a separate resume action

#### Scenario: Repair is stale or invalid
- **WHEN** revision changed, target is unknown/incompatible/terminal, or rebuilt state invalid
- **THEN** repair SHALL fail before mutation
- **AND** active runs and effects SHALL remain unchanged

#### Scenario: Repaired-away agent submits
- **WHEN** agent from expired run submits handoff after repair
- **THEN** engine SHALL reject stale capability
- **AND** repaired workflow SHALL remain unchanged
