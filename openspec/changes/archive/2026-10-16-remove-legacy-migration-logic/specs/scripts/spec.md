## MODIFIED Requirements

### Requirement: User configuration is initialized by copy
The installation flow SHALL initialize `config.json` under the shared canonical configuration root, defaulting to `~/.config/agentic-coding`, from the portable `pi/herdr-workflow.json` defaults as a regular file only when no current target exists. It SHALL NOT create a configuration symlink or replace an existing regular file or symlink. Historical configuration files SHALL NOT be treated as an applicable source, migrated, or used to shadow the canonical JSON file.

#### Scenario: Fresh installation copies defaults
- **WHEN** no current canonical `config.json` exists
- **THEN** installation SHALL create the parent directory if needed and copy portable JSON defaults as a regular file
- **AND** it SHALL NOT include machine-specific profiles, presets or credentials

#### Scenario: Existing current configuration is preserved
- **WHEN** current JSON user configuration contains profiles or presets
- **THEN** installation SHALL preserve it and SHALL NOT shadow it with fresh defaults

#### Scenario: Historical configuration is not imported
- **WHEN** a TOML or other historical configuration file exists without the current JSON target
- **THEN** installation SHALL not read, migrate, replace, or copy that file
- **AND** it SHALL leave the source unchanged

#### Scenario: Existing configuration path is a symlink
- **WHEN** the target configuration path is a symlink
- **THEN** installation SHALL NOT replace, retarget or overwrite it

## REMOVED Requirements

### Requirement: Existing machine-specific configuration is migrated before source reduction

**Reason**: Install-time conversion of historical and repository-backed configuration is removed.
**Migration**: Users must place desired settings in the canonical current JSON configuration using an external/manual process; the installer does not convert old files or change their contents.

#### Scenario: Installer does not migrate machine-specific settings
- **WHEN** only an old configuration source contains machine-specific profiles or presets
- **THEN** the installer SHALL leave it unchanged and SHALL NOT synthesize a canonical JSON file from it
