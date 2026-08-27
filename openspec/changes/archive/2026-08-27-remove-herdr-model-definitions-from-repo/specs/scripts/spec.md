# Scripts Specification Delta

## ADDED Requirements

### Requirement: User configuration is initialized by copy
The installation flow SHALL initialize `~/.config/agentic-coding/config.toml` by copying the repository's `pi/herdr-workflow.toml` defaults as a regular file only when the destination path does not already exist. It SHALL NOT create a symlink for this configuration and SHALL NOT overwrite or replace an existing user configuration path, including an existing regular file or symlink.

#### Scenario: Fresh installation copies defaults
- **WHEN** the installation flow runs and `~/.config/agentic-coding/config.toml` does not exist
- **THEN** it SHALL create the parent directory if needed
- **AND** it SHALL copy `pi/herdr-workflow.toml` to the destination as a regular file
- **AND** the destination SHALL not be a symlink

#### Scenario: Existing user configuration is preserved
- **WHEN** the installation flow runs and `~/.config/agentic-coding/config.toml` already exists with user-specific profiles or presets
- **THEN** it SHALL leave that file's contents and file type unchanged
- **AND** it SHALL not copy repository defaults over it

#### Scenario: Existing configuration path is a symlink
- **WHEN** the installation flow runs and `~/.config/agentic-coding/config.toml` is already a symlink
- **THEN** it SHALL not replace, retarget, or overwrite the symlink
- **AND** it SHALL not create a new repository-backed symlink for the configuration

### Requirement: Existing machine-specific configuration is migrated before source reduction
The change rollout SHALL materialize the current repository-backed configuration into `~/.config/agentic-coding/config.toml` as a regular user-owned file before removing machine-specific profiles and presets from `pi/herdr-workflow.toml`. The migration SHALL preserve the current profiles and presets and SHALL not add a copy of those definitions to any repository artifact.

#### Scenario: Current presets are retained during migration
- **WHEN** the current configuration contains model profiles and presets supplied by the repository-backed configuration
- **AND** the configuration is copied to the user location before the repository template is reduced
- **THEN** the user configuration SHALL remain a regular file containing those profiles and presets
- **AND** the reduced repository template SHALL contain only defaults
