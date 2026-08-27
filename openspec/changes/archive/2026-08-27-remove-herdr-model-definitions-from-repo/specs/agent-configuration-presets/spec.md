# Agent configuration presets Specification Delta

## MODIFIED Requirements

### Requirement: Agent configuration presets
Configuration SHALL support named custom agent configuration presets that assign user-defined agent profiles to workflow steps, optionally with per-role overrides within a step and a preset-level fallback profile. A configuration SHALL be valid without `agents.default_profile`, profiles, routes, or custom presets. The built-in `use-default-model` preset SHALL not require a persisted profile reference and SHALL allow its harness to be configured as `pi`, `opencode`, or `opencode-v2` without a model. Custom presets SHALL be stored in an explicitly supplied effective user/project agents configuration, but the repository's default configuration SHALL NOT ship custom presets or profiles and custom entries SHALL NOT require a repository commit.

#### Scenario: Preset is valid
- **WHEN** a custom preset references only existing custom profile names and assigns at most one profile per step and per step-role pair
- **THEN** the preset SHALL be available for selection

#### Scenario: Preset references unknown profile
- **WHEN** configuration parsing encounters a custom preset entry naming a profile that does not exist
- **THEN** configuration validation SHALL fail before any workflow starts
- **AND** the error SHALL identify the preset, the entry, and the unknown profile name

#### Scenario: Agents configuration has no custom profiles
- **WHEN** configuration parsing encounters no agents section or an agents section with no profiles and no custom presets
- **THEN** configuration validation SHALL succeed
- **AND** the built-in `use-default-model` preset SHALL remain available
