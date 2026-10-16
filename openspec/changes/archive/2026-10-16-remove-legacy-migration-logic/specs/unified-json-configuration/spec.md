## MODIFIED Requirements

### Requirement: One canonical configuration root
All application-owned global configuration consumers SHALL share one resolver, defaulting to `~/.config/agentic-coding`. Explicit config-dir arguments SHALL take precedence over `AGENTIC_CODING_CONFIG_DIR`, then the canonical default. Resolved roots SHALL propagate consistently to application subprocesses; root selection SHALL NOT depend on `.env` contents. The deprecated `DEVENV_CONFIG_DIR` alias SHALL NOT select or warn about an alternate root.

#### Scenario: Explicit root selection
- **WHEN** an explicit config-dir argument or `AGENTIC_CODING_CONFIG_DIR` is present
- **THEN** it SHALL select the single root used by all current configuration consumers
- **AND** the deprecated variable SHALL NOT cause a second read or write

#### Scenario: Legacy files are not selected
- **WHEN** startup finds TOML or another historical configuration file instead of the current JSON file
- **THEN** it SHALL ignore or clearly reject that file without importing, shadow-merging, or rewriting it

### Requirement: Structured configuration uses JSON with preserved scope
Application-owned structured configuration SHALL use validated current JSON, including global workflow configuration in `config.json`. Environment JSON layout and domain semantics SHALL remain intact. New repository overlays SHALL use `.pi/herdr-workflow.json`; TOML overlays and legacy replacement files SHALL NOT be read or converted. Global configuration loading SHALL preserve the established project-over-base scope rules without treating historical formats as a source.

#### Scenario: Project overrides global defaults
- **WHEN** a canonical-repository JSON overlay supplies agent settings
- **THEN** effective resolution and write/conflict rules SHALL preserve existing project-over-base behavior and unrelated fields

#### Scenario: Explicit current JSON replacement
- **WHEN** `HERDR_WORKFLOW_CONFIG` selects a supported current JSON file
- **THEN** that file SHALL retain full-replacement semantics without an implicit project overlay

#### Scenario: Independent workflow
- **WHEN** repository-independent wiki or research settings are resolved
- **THEN** cwd configuration SHALL NOT become a project overlay

#### Scenario: Historical formats are not rewritten
- **WHEN** a configuration lookup encounters a TOML file, deprecated root variable, or migration journal
- **THEN** it SHALL not import, rename, edit, or copy that source into the canonical root

## REMOVED Requirements

### Requirement: Migration is explicit and non-destructive

**Reason**: The application no longer offers configuration migration, preview, apply, journal recovery, backup publication, or conflict resolution for historical files.
**Migration**: Keep the current `config.json` and `tui.json` in the canonical root. Any conversion must be performed outside this build with the legacy application; this build leaves the old source untouched.

#### Scenario: Configuration migration command is absent
- **WHEN** a user invokes `agentic-coding config migrate`
- **THEN** no migration preview or apply operation SHALL run and no configuration file SHALL be changed

### Requirement: Configuration relocation does not relocate runtime data

**Reason**: The requirement describes a removed configuration migration/relocation workflow.
**Migration**: Runtime data stays at its existing current location; this build performs no relocation.

#### Scenario: Runtime data is not moved
- **WHEN** current configuration is loaded
- **THEN** the application SHALL NOT relocate the workflow store, environment state, telemetry, wiki, checkouts, or logs
