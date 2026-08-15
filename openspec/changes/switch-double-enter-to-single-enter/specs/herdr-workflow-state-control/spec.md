## RENAMED Requirements

- FROM: `### Requirement: Explicit resume after repair`
- TO: `### Requirement: Explicit resume of paused workflow`

## MODIFIED Requirements

### Requirement: Validated workflow repair
The system SHALL let developer repair active workflow to registered target step only through revision-checked command carrying non-empty reason, expiring incompatible run capabilities, rebuilding target-step state, validating all invariants, and directly retriggering the target step without an intermediate paused state.

#### Scenario: Developer previews repair
- **WHEN** dashboard opens repair for active workflow
- **THEN** engine SHALL return only target steps compatible with pinned definition and current durable evidence
- **AND** preview SHALL identify runs/evidence that repair would expire or retain

#### Scenario: Developer confirms repair
- **WHEN** developer confirms target with current revision and reason
- **THEN** engine SHALL expire incompatible run capabilities, rebuild target-step state, validate all invariants, commit repair event, and enter the target step directly so successor runs/effects start immediately
- **AND** repair SHALL NOT pause the workflow or require a separate resume action

#### Scenario: Repair is stale or invalid
- **WHEN** revision changed, target is unknown/incompatible/terminal, reason empty, or rebuilt state invalid
- **THEN** repair SHALL fail before mutation
- **AND** active runs and effects SHALL remain unchanged

#### Scenario: Repaired-away agent submits
- **WHEN** agent from expired run submits handoff after repair
- **THEN** engine SHALL reject stale capability
- **AND** repaired workflow SHALL remain unchanged

### Requirement: Explicit resume of paused workflow
A paused workflow SHALL resume only through current engine-provided action and SHALL revalidate routing, adapter capabilities, artifacts, and entry guards before creating run/effects; repair SHALL NOT produce a paused workflow.

#### Scenario: Paused workflow resumes successfully
- **WHEN** developer invokes available resume action with current revision on a paused workflow
- **THEN** engine SHALL enter the current step and enqueue required effects through normal command runtime

#### Scenario: Paused workflow cannot resume
- **WHEN** required definition, runtime, artifact, or entry condition is unavailable
- **THEN** resume SHALL fail closed while workflow remains paused
- **AND** diagnostic SHALL identify unmet requirement

#### Scenario: Repaired workflow needs no resume
- **WHEN** repair commits successfully
- **THEN** workflow SHALL already be active at the target step with successor runs/effects started
- **AND** resume SHALL NOT be offered as an available action for the repaired workflow
