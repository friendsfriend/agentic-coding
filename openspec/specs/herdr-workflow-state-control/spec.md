# herdr-workflow-state-control Specification

## Purpose
TBD - created by archiving change manual-workflow-state-overwrite. Update Purpose after archive.

## Requirements

### Requirement: Validated workflow repair
The system SHALL let developer repair active workflow to registered target step only through revision-checked command carrying non-empty reason and producing fully valid paused snapshot.

#### Scenario: Developer previews repair
- **WHEN** dashboard opens repair for active workflow
- **THEN** engine SHALL return only target steps compatible with pinned definition and current durable evidence
- **AND** preview SHALL identify runs/evidence that repair would expire or retain

#### Scenario: Developer confirms repair
- **WHEN** developer confirms target with current revision and reason
- **THEN** engine SHALL expire incompatible run capabilities, rebuild target-step state, validate all invariants, commit repair event, and leave workflow paused
- **AND** repair SHALL NOT launch successor agent until separate explicit resume action

#### Scenario: Repair is stale or invalid
- **WHEN** revision changed, target is unknown/incompatible/terminal, reason empty, or rebuilt state invalid
- **THEN** repair SHALL fail before mutation
- **AND** active runs and effects SHALL remain unchanged

#### Scenario: Repaired-away agent submits
- **WHEN** agent from expired run submits handoff after repair
- **THEN** engine SHALL reject stale capability
- **AND** repaired workflow SHALL remain unchanged

### Requirement: Explicit resume after repair
A repaired workflow SHALL resume only through current engine-provided action and SHALL revalidate routing, adapter capabilities, artifacts, and entry guards before creating run/effects.

#### Scenario: Repair resumes successfully
- **WHEN** developer invokes available resume action with current revision
- **THEN** engine SHALL enter repaired step and enqueue required effects through normal command runtime

#### Scenario: Repair cannot resume
- **WHEN** required definition, runtime, artifact, or entry condition is unavailable
- **THEN** resume SHALL fail closed while workflow remains paused
- **AND** diagnostic SHALL identify unmet requirement
