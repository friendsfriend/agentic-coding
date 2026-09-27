# Spec Delta

## MODIFIED Requirements

### Requirement: Pi, OpenCode, and OpenCode V2 adapters
The system SHALL provide adapters for Pi, stable OpenCode `opencode`, and official OpenCode V2 beta `opencode2`, all using the selected multiplexer's managed agent lifecycle and common assignment/handoff protocol.

#### Scenario: Pi run launches
- **WHEN** run routes to Pi profile and Pi is installed
- **THEN** engine SHALL launch Pi through the selected multiplexer's agent lifecycle
- **AND** send rendered assignment message through detected agent

#### Scenario: OpenCode run launches
- **WHEN** run routes to stable OpenCode profile and `opencode` is installed
- **THEN** engine SHALL launch the OpenCode agent through the selected multiplexer's lifecycle with profile model/options
- **AND** use same rendered assignment and handoff contracts as Pi

#### Scenario: OpenCode V2 run launches
- **WHEN** run routes to OpenCode V2 profile and official `opencode2` is installed
- **THEN** engine SHALL launch detected OpenCode V2 process through the selected multiplexer's managed OpenCode lifecycle using isolated executable resolution
- **AND** use same rendered assignment and handoff contracts as other adapters

#### Scenario: Configured executable is missing
- **WHEN** selected Pi, OpenCode, or OpenCode V2 executable is absent
- **THEN** preflight SHALL fail with runtime/profile diagnostic before state advances or pane is created
- **AND** engine SHALL NOT install executable automatically

#### Scenario: Selected multiplexer is unavailable
- **WHEN** the selected multiplexer runtime cannot be reached while routing an agent step
- **THEN** the launch SHALL fail with a diagnostic naming the selected runtime
- **AND** the engine SHALL NOT launch the agent through another multiplexer
