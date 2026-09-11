## MODIFIED Requirements

### Requirement: Terminal color capture at startup
The TUI SHALL query the controlling terminal for its 16 ANSI palette entries and default foreground/background through the OpenTUI renderer palette API during interactive startup, before applying the persisted theme selection. Capture SHALL be bounded by a timeout and SHALL NOT install a competing manual terminal-input reader. Renderer-owned input handling SHALL remain valid after capture.

#### Scenario: Terminal answers OSC color queries
- **WHEN** the TUI starts in an interactive TTY and the renderer palette query receives valid colors within the timeout
- **THEN** the captured palette and foreground/background SHALL be normalized into concrete hex values
- **AND** normal renderer input handling SHALL remain active without a second capture listener

#### Scenario: Terminal does not answer within the timeout
- **WHEN** the palette query times out or fails
- **THEN** startup SHALL continue without blocking terminal input
- **AND** no captured system theme SHALL be registered

#### Scenario: Non-interactive or headless run
- **WHEN** the application runs without an interactive TTY, including headless/JSON commands
- **THEN** terminal capture SHALL be skipped
- **AND** no system theme SHALL be registered
