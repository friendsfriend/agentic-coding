## ADDED Requirements

### Requirement: One UI preference authority
All feature surfaces SHALL share one local UI preferences adapter and active theme store. The adapter SHALL use `$DEVENV_CONFIG_DIR/tui.json`, defaulting to `~/.config/devenv/tui.json`, and SHALL keep workflow execution configuration separate.

#### Scenario: Existing selection takes precedence
- **WHEN** canonical UI preferences already contain a valid theme and legacy workflow preferences differ
- **THEN** the canonical selection SHALL win for every feature
- **AND** startup SHALL NOT overwrite either source file merely to read the selection

#### Scenario: Legacy theme is imported
- **WHEN** no canonical selection exists and a valid legacy agentic-coding selection is available
- **THEN** the adapter SHALL import that selection without losing unrelated canonical preference keys
- **AND** subsequent saves SHALL use the canonical file atomically

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
