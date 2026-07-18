## ADDED Requirements

### Requirement: Lazygit popup on prefix+g
The system SHALL open lazygit in a session-modal popup when the user presses prefix+g.

#### Scenario: prefix+g opens lazygit popup
- **GIVEN** a running herdr session with the updated config
- **WHEN** the user presses prefix (ctrl+g) then g
- **THEN** a popup window opens running lazygit
- **AND** the popup is 80% of terminal width and 80% of terminal height
- **AND** exiting lazygit closes the popup and returns to the previous layout

### Requirement: Nvim popup on prefix+e
The system SHALL open nvim in a session-modal popup when the user presses prefix+e.

#### Scenario: prefix+e opens nvim popup
- **GIVEN** a running herdr session with the updated config
- **WHEN** the user presses prefix (ctrl+g) then e
- **THEN** a popup window opens running nvim
- **AND** the popup is 80% of terminal width and 80% of terminal height
- **AND** quitting nvim closes the popup and returns to the previous layout

### Requirement: Rebound goto action
The system SHALL invoke the goto action on prefix+shift+g instead of prefix+g.

#### Scenario: goto moved to prefix+shift+g
- **GIVEN** a running herdr session with the updated config
- **WHEN** the user presses prefix (ctrl+g) then shift+g
- **THEN** the goto action is invoked (e.g. workspace/tab switcher)

### Requirement: Rebound edit_scrollback action
The system SHALL invoke edit_scrollback on prefix+shift+e instead of prefix+e.

#### Scenario: edit_scrollback moved to prefix+shift+e
- **GIVEN** a running herdr session with the updated config
- **WHEN** the user presses prefix (ctrl+g) then shift+e
- **THEN** the scrollback editor opens

### Requirement: Config validation
The config SHALL pass herdr config check after changes.

#### Scenario: config check passes
- **GIVEN** the updated config.toml with rebindings and popup commands
- **WHEN** the user runs `herdr config check`
- **THEN** no errors are reported
