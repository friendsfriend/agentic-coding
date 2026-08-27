## Why

The repository currently ships machine-specific agent profiles and presets, causing model/provider choices to be shared through a dotfiles checkout and installed as a symlink. Keep those choices in the local user's configuration instead, while allowing the repository to provide only safe application defaults and ensuring installation does not overwrite an existing user configuration.

## What Changes

- **BREAKING** Remove the provider/model-specific profiles and custom presets from the repository's `pi/herdr-workflow.toml`; retain only the model-agnostic application defaults and built-in `use-default-model` configuration.
- Preserve the current machine's full model/profile configuration in the user's configuration file as a one-time migration before the repository file is reduced to defaults; do not add those machine-specific values back to source control.
- Change installation so the repository configuration is copied as a regular file to `~/.config/agentic-coding/config.toml` only when that path does not already exist, rather than symlinking the repository file or replacing an existing user file/symlink.
- Update installation-focused checks and documentation to describe user-owned configuration and first-install/non-overwrite behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-configuration-presets`: Custom profiles and presets remain supported by the application but are user-owned configuration, not model definitions shipped or committed by this repository.
- `default-model-preset`: The repository-provided configuration contains only defaults and the built-in model-agnostic preset; a user configuration may retain machine-specific custom entries independently.
- `scripts`: Installation must initialize the user configuration by copying defaults once and must not manage it as a symlink or overwrite an existing configuration.

## Impact

Affected files include `pi/herdr-workflow.toml`, `scripts/stow.sh`, installation/stow smoke checks, and configuration documentation in `README.md`. Runtime routing and dashboard support for user-defined profiles/presets remain unchanged; only the source and installation ownership of those values changes. Existing installations need the current symlink target copied to the regular user configuration before the repository configuration is reduced, so the machine's current presets are retained.
