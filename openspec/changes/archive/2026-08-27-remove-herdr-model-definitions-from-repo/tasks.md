## 1. Preserve the current machine configuration

- [x] 1.1 Before reducing the tracked template, materialize the current repository-backed `~/.config/agentic-coding/config.toml` target as a regular user-owned file, preserving its existing `[agents.profiles]` and `[agents.presets]` values; verify those sections remain present and do not commit the copied file or model definitions to the repository.
- [x] 1.2 Update `README.md` to document the required one-time migration order for existing installations and the user-owned location for custom profiles and presets.

## 2. Reduce the repository defaults

- [x] 2.1 Remove all machine-specific `[agents.profiles.*]` and custom `[agents.presets.*]` entries from `pi/herdr-workflow.toml`, retaining only the model-agnostic `use-default-model` configuration and portable workflow, project, telemetry, and UI defaults.
- [x] 2.2 Verify the reduced template parses as TOML, contains no provider/model-specific profile or custom preset definitions, and still exposes the built-in `use-default-model` preset.

## 3. Change configuration installation ownership

- [x] 3.1 Update `scripts/stow.sh` so a missing `~/.config/agentic-coding/config.toml` is initialized by copying `pi/herdr-workflow.toml` as a regular file, while an existing regular file or symlink is left unchanged and no repository-backed config symlink is created.
- [x] 3.2 Extend `scripts/test-stow.sh` with focused assertions for fresh copy/regular-file behavior, preservation of customized existing content across repeated installs, and non-replacement of an existing symlink.

## 4. Validate the scoped change

- [x] 4.1 Run `bash -n scripts/stow.sh scripts/test-stow.sh` and `bash scripts/test-stow.sh`; confirm the focused installation checks pass.
- [x] 4.2 Run `openspec validate remove-herdr-model-definitions-from-repo --strict` and confirm the validated files and migration/install evidence are reflected in the final handoff.
