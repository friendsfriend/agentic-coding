# system-terminal-theme Specification

## Purpose
TBD - created by archiving change system-terminal-theme. Update Purpose after archive.
## Requirements
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

### Requirement: System theme mapping

The TUI SHALL map captured terminal colors into a theme definition whose values are concrete hex colors (not ANSI index numbers), covering every theme key the UI consumes so that no consumed key resolves to a bare hardcoded fallback. The mapping SHALL derive semantic keys from the ANSI palette and default foreground/background (for example error from red, success from green, warning from yellow, primary from blue, info from cyan, accent from magenta, background from the default background, text from the default foreground) and SHALL derive panel/surface/border keys from those captured colors.

#### Scenario: Captured colors populate the UI palette
- **WHEN** a system theme is built from a successfully captured terminal palette
- **THEN** the theme's `background` matches the terminal's default background and `text` matches the terminal's default foreground
- **AND** the semantic keys (`primary`, `secondary`, `accent`, `error`, `warning`, `success`, `info`, `textMuted`) resolve to colors derived from the captured palette
- **AND** the panel, surface, and border keys resolve to captured-derived colors rather than bundled-theme fallbacks

### Requirement: System theme registration and selection

The TUI SHALL register a successfully built system theme under the name `system` so it appears in the theme picker, is selectable, and persists like any other theme. The `system` entry SHALL be present only when capture succeeded. Registration SHALL occur before the persisted theme name is applied at startup so that a saved `system` selection resolves on launch.

#### Scenario: System theme is offered when capture succeeds
- **WHEN** terminal color capture succeeds at startup
- **THEN** a `system` entry is available in the theme picker and can be selected
- **AND** selecting `system` applies the captured terminal colors to the TUI

#### Scenario: Saved system selection resolves on next launch
- **WHEN** the persisted theme selection is `system` and capture succeeds on a later launch
- **THEN** the TUI applies the freshly captured terminal colors under the `system` theme

#### Scenario: Saved system selection with no captured theme
- **WHEN** the persisted theme selection is `system` but capture does not succeed
- **THEN** no `system` entry is registered
- **AND** the TUI falls back to the default theme instead of failing

