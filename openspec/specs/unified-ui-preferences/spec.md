# unified-ui-preferences Specification

## Purpose
TBD - created by archiving change unify-terminal-ui-primitives. Update Purpose after archive.
## Requirements
### Requirement: One UI preference authority
All feature surfaces SHALL share one local UI preferences adapter and active theme store. The adapter SHALL use only `tui.json` under the shared canonical configuration root, defaulting to `~/.config/agentic-coding/tui.json`, and SHALL keep workflow execution configuration separate. It SHALL NOT import preferences from a workflow config or historical file.

#### Scenario: Existing selection takes precedence
- **WHEN** canonical `tui.json` contains a valid theme and another file contains a different theme
- **THEN** the canonical selection SHALL win for every feature
- **AND** startup SHALL NOT overwrite either source file merely to read the selection

#### Scenario: Old preference is ignored
- **WHEN** no canonical selection exists and an old workflow config contains a theme
- **THEN** startup SHALL use the normal current default and SHALL NOT import or persist the old selection

#### Scenario: Canonical saves remain atomic
- **WHEN** a preference is changed
- **THEN** subsequent saves SHALL use the canonical file atomically and preserve unrelated current JSON keys

### Requirement: Theme assets and custom names have one registry
The application SHALL have one built-in asset set, one custom-theme loader and one picker. Custom theme errors and name conflicts SHALL be handled without destructive overwrite; `system` SHALL remain reserved for successful terminal capture.

#### Scenario: Theme changes across component families
- **WHEN** a user selects a theme while environment and workflow views or dialogs are mounted
- **THEN** all semantic colors SHALL update through the same store, including badges, diffs and hidden views when shown
- **AND** no component SHALL retain a separate hardcoded Catppuccin state

#### Scenario: Invalid custom theme or reserved name
- **WHEN** a custom file cannot be decoded or attempts to replace `system`
- **THEN** the application SHALL retain usable built-in themes and report the rejected file without overwriting it

### Requirement: Preference failures are recoverable
Preference reads/writes SHALL validate theme names, preserve unrelated values and surface write failures without corrupting the last saved file.

#### Scenario: Save fails
- **WHEN** the settings directory is not writable
- **THEN** the user SHALL receive an error and the previous settings file SHALL remain intact

