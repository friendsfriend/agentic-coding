# add-agent-plugin-system Specification

## Purpose
Allow planner and worker agents to inherit and use the user's installed pi extensions, skills, and tools, while keeping specialized agents restricted. Provide discoverability and exclusion management for agent plugins.

## Requirements

### Requirement: Agent role classification
The system SHALL classify agent roles into two categories: unrestricted (planner, worker) and restricted (all verifiers, triage, recovery, archive).

#### Scenario: Planner inherits user extensions
- **GIVEN** the user has pi extensions installed in `~/.pi/agent/extensions/` or via `pi install`
- **WHEN** the workflow starts a planner or worker agent via `pi_command()`
- **THEN** the pi command SHALL NOT include `--no-extensions` or `--no-skills`
- **AND** the pi command SHALL NOT include a hardcoded `--tools` restriction
- **AND** the pi command SHALL still include `--extension` pointing to `agent-definitions/extensions/herdr-telemetry.ts`

#### Scenario: Verifier stays restricted
- **GIVEN** a verifier, triage, recovery, or archive role
- **WHEN** the workflow starts that agent
- **THEN** the pi command SHALL include `--no-extensions` and `--no-skills` (current behavior preserved)
- **AND** the pi command SHALL include the hardcoded `--tools` restriction

### Requirement: Extension exclusion
Users SHALL be able to exclude specific extensions from unrestricted agent roles via configuration.

#### Scenario: Extension excluded globally
- **GIVEN** a `[plugins]` section in `herdr-workflow.toml` with `exclude_extensions = ["my-tui-game"]`
- **WHEN** a planner or worker agent starts
- **THEN** the `my-tui-game` extension SHALL be excluded (via `--exclude-extensions` flag)

#### Scenario: Extension excluded per-role
- **GIVEN** a `[plugins.roles.worker]` section with `exclude_extensions = ["heavy-fetcher"]`
- **WHEN** a worker agent starts
- **THEN** the `heavy-fetcher` extension SHALL be excluded
- **WHEN** a planner agent starts
- **THEN** the `heavy-fetcher` extension SHALL NOT be excluded (unless also listed globally)

#### Scenario: No exclusion config
- **GIVEN** no `[plugins]` section exists in `herdr-workflow.toml`
- **WHEN** a planner or worker agent starts
- **THEN** all user extensions SHALL be loaded without exclusion

### Requirement: Plugin discoverability
The `herdr-workflow plugin` command SHALL provide subcommands for listing, installing, and managing agent plugins.

#### Scenario: List installed plugins
- **WHEN** the user runs `herdr-workflow plugin list`
- **THEN** it SHALL display all discovered extensions and their status per role (active or excluded)

#### Scenario: Install a plugin with role assignment
- **WHEN** the user runs `herdr-workflow plugin install npm:@foo/pi-jira --worker --planner`
- **THEN** it SHALL invoke `pi install npm:@foo/pi-jira`
- **AND** record the install with roles `["worker", "planner"]` in `plugin-assignments.json`

#### Scenario: Install a local extension
- **WHEN** the user runs `herdr-workflow plugin install-local ./my-ext.ts --worker`
- **THEN** it SHALL copy/symlink `my-ext.ts` to `~/.pi/agent/extensions/`
- **AND** record the install with role `["worker"]` in `plugin-assignments.json`

### Requirement: Backward compatibility
Existing workflows and installed packages without agent role metadata SHALL continue to work without changes.

#### Scenario: No plugin-assignments.json exists
- **GIVEN** no `plugin-assignments.json` file exists
- **WHEN** `plugin list` is run
- **THEN** it SHALL show all extensions as active for all unrestricted roles

#### Scenario: Only restricted roles configured
- **GIVEN** only restricted roles (verifiers, triage, etc.) exist in the workflow config
- **WHEN** the workflow starts
- **THEN** behavior SHALL be identical to pre-change behavior
