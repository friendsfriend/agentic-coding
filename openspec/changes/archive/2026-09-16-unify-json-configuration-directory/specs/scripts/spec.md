## MODIFIED Requirements

### Requirement: User configuration is initialized by copy
The installation flow SHALL initialize `config.json` under the shared canonical configuration root, defaulting to `~/.config/agentic-coding`, from the portable `pi/herdr-workflow.json` defaults as a regular file only when no existing target or applicable legacy configuration would be overwritten or shadowed. It SHALL NOT create a configuration symlink or replace an existing regular file or symlink. Applicable legacy configuration SHALL require explicit migration rather than silent copying of fresh defaults.

#### Scenario: Fresh installation copies defaults
- **WHEN** no existing canonical or applicable legacy configuration exists
- **THEN** installation SHALL create the parent directory if needed and copy portable JSON defaults as a regular file
- **AND** it SHALL NOT include machine-specific profiles, presets or credentials

#### Scenario: Existing user configuration is preserved
- **WHEN** existing JSON or legacy user configuration contains user profiles or presets
- **THEN** installation SHALL preserve it and SHALL NOT shadow it with fresh defaults

#### Scenario: Existing configuration path is a symlink
- **WHEN** the target configuration path is a symlink
- **THEN** installation SHALL NOT replace, retarget or overwrite it and SHALL identify any migration needed

### Requirement: Existing machine-specific configuration is migrated before source reduction
Any migration of machine-specific configuration from repository-backed or legacy files SHALL preserve its effective profiles/presets in a regular user-owned canonical JSON file through explicit validated migration before reducing its source template. Known credential values SHALL move into protected `.env` storage with references in JSON. Original source data SHALL remain in protected backups and SHALL NOT be copied into repository artifacts.

#### Scenario: Current presets are retained during migration
- **WHEN** legacy configuration contains machine-specific profiles and presets
- **THEN** explicit migration SHALL preserve their effective values in user-owned JSON before source reduction
- **AND** portable repository defaults SHALL remain model-agnostic and secret-free
