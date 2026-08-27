## Context

`pi/herdr-workflow.toml` is currently both the source-controlled default configuration and the source of the machine's provider/model profiles and presets. `scripts/stow.sh` installs it by creating or replacing `~/.config/agentic-coding/config.toml` with a symlink. This couples a user's private routing choices to the repository and allows later checkouts or installs to change the effective configuration.

The desired ownership boundary is: repository source provides portable defaults; the regular file under `~/.config/agentic-coding/config.toml` is user-owned and may contain private machine-specific profiles and presets. The change must preserve the current machine's existing configuration during the transition and must not overwrite an already initialized user configuration.

## Goals / Non-Goals

**Goals:**

- Reduce the tracked `pi/herdr-workflow.toml` to portable application defaults, including only the model-agnostic built-in preset and non-model workflow/project/UI defaults.
- Preserve the current machine's profile and preset values in the user configuration as a one-time migration before the tracked source is reduced.
- Make installation initialize a missing user config by copying the tracked template as a regular file.
- Make repeated installs leave an existing regular user config unchanged and stop creating repository-backed config symlinks.
- Keep runtime parsing, routing, dashboard editing, and project-overlay behavior unchanged for configurations that users already own or explicitly provide.

**Non-Goals:**

- Removing support for custom profiles, presets, routes, or dashboard model configuration.
- Changing runtime model validation or routing precedence.
- Moving credentials, telemetry, or other runtime state.
- Automatically migrating arbitrary project-level `.pi/herdr-workflow.toml` files.

## Decisions

### Keep one tracked defaults template

Retain `pi/herdr-workflow.toml` as the source for first-time initialization, but remove its `[agents.presets]` custom entries and `[agents.profiles]` entries. Keep `[agents]` only as needed for the built-in `use-default-model` preset and keep the portable workflow, projects, telemetry, and UI defaults.

This preserves a discoverable default while ensuring a fresh checkout contains no provider-specific model definitions. A separate checked-in backup of the old profiles is deliberately not introduced because it would continue distributing the machine-specific data.

### Copy, do not link, at the user-config boundary

Update `scripts/stow.sh` to create the destination directory and copy the template only when `~/.config/agentic-coding/config.toml` is absent. The copy must be a regular file, and the script must not use `ln -sfn` for this destination. Existing user files must remain byte-for-byte untouched on subsequent runs, including their custom profiles and presets; an existing symlink is an existing path and must not be silently replaced or followed for an overwrite.

A focused shell test will verify first-run copy, regular-file status, preservation after source changes, and non-overwrite behavior for an existing user file/path.

### Perform the current-machine migration before reducing source

The existing repository-backed config must be materialized into the user configuration before the tracked template is stripped: copy the current resolved config contents to `~/.config/agentic-coding/config.toml` as a regular file, preserving all existing profiles and presets, then apply the repository change. This ordering is the only place where the current machine's model choices are preserved; the implementation must not encode them in a new repository artifact. The change documentation and task list will make this prerequisite explicit so a current installation is not accidentally reduced to defaults.

### Limit the code change to ownership and installation

Do not alter `agentic-coding/src/workflow` or dashboard configuration resolution. Those consumers already load the effective user config and support custom entries. Update README installation/configuration guidance so it states that the tracked file is a defaults template and custom model configuration belongs in the user config. Keep existing project-level configuration documentation only where it describes an intentional, separately supplied project overlay.

## Risks / Trade-offs

- **[Risk]** Reducing the tracked source before copying the current symlink target would discard the machine's custom profiles and presets. → **Mitigation:** perform and document the ordered one-time materialization before editing/removing the tracked entries; verify the resulting destination is a regular file and still contains the expected custom sections.
- **[Risk]** A later install could overwrite a user's customized config. → **Mitigation:** guard the copy on destination absence and test repeated installs with a modified existing file.
- **[Risk]** An old repository symlink may remain on installations that skip the migration. → **Mitigation:** document the migration/cleanup step; the new installer creates no symlinks and never silently overwrites an existing path.
- **[Trade-off]** Fresh installs no longer receive the repository maintainer's model presets automatically. → **Mitigation:** retain the built-in model-agnostic preset and document that users can add custom profiles/presets to their user config.
