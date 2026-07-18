# stow-exempt-agent-definitions Specification

## Purpose
Document that `agent-definitions/` is an exempt path in stow verifier policy — it is intentionally not stow-managed and not an installable user-facing asset.

## Requirements

### Requirement: Verifier policy exemption
The stow installation verifier policy SHALL classify `agent-definitions/` as an exempt path.

#### Scenario: Agent-definitions path is verified as exempt
- **GIVEN** the stow verifier policy at `.pi/verifier/stow-installation.md`
- **WHEN** evaluating a changed file under `agent-definitions/`
- **THEN** the verifier SHALL NOT require `scripts/stow.sh` coverage for that file
- **AND** the change artifacts SHALL explain that `agent-definitions/` is loaded by explicit herdr-workflow path, not by pi discovery

#### Scenario: Non-herdr pi assets still stowed
- **GIVEN** a changed file under `pi/extensions/` or `pi/skills/`
- **WHEN** the verifier evaluates stow coverage
- **THEN** the verifier SHALL still require `scripts/stow.sh` coverage (unchanged from current behavior)
