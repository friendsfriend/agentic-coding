## Why

Application configuration is split between `~/.config/agentic-coding` and `~/.config/devenv`, with independent directory resolution and TOML workflow configuration beside JSON environment definitions. One application needs one configuration root and consistent JSON configuration, while retaining devenv's `.env` approach for provider and workflow secrets.

## What Changes

- **BREAKING** Make `~/.config/agentic-coding` the default root for all application-owned global configuration, with one shared resolver and `AGENTIC_CODING_CONFIG_DIR` override.
- Replace application-owned workflow TOML configuration with JSON; retain existing devenv JSON directory structure, UI preferences, themes, definitions and configuration assets under the unified root.
- Retain `.env` for environment/bootstrap values and extend its secret-reference behavior to workflow configuration. JSON stores `${VARIABLE}` references, not inline secrets.
- Add explicit dry-run/apply migration with conflict detection, protected backups, validation and recoverable cutover; never relocate live user files at ordinary startup.
- Preserve effective workflow settings, profiles/presets, scope/precedence, project overrides, runtime paths and running-workflow pins. No database, repository or wiki-content relocation.
- Update Settings, installation/templates, CLI/server/TUI/subprocess consumers and documentation together; remove split-root fallback after migration.

## Capabilities

### New Capabilities
- `unified-json-configuration`: Canonical directory/layout, JSON workflow configuration, shared `.env` references and safe migration.

### Modified Capabilities
- `unified-ui-preferences`: Preferences and custom themes resolve under the agentic-coding root.
- `bun-environment-state`: Environment configuration shares the canonical root without moving runtime state.
- `scripts`: Installation creates portable JSON defaults; existing user configuration is migrated explicitly, never overwritten.
- `default-model-preset`: Portable default configuration is provided as JSON rather than TOML.

## Impact

Depends on `centralize-application-settings` for final Settings integration; it need not wait for contextual workflow launch or dashboard isolation. Re-read that change after it is implemented/archived; do not edit its in-progress files as part of proposal creation. This change supersedes its legacy storage-path examples while retaining its client/server ownership rules.

Affected code includes `src/backend/home.ts`, `src/workflow/{effects,paths,profiles}.ts`, `src/server/config.ts`, environment/integration loaders and `.env` helpers, `src/tui/shared/preferences.ts`, `src/tui/settings/`, imported core logger/bootstrap consumers, installation scripts and `pi/herdr-workflow.toml`. No new configuration framework or dependency is required. Proposal creation does not inspect, migrate or modify real user configuration or secrets.
