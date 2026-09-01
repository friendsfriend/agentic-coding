## Purpose

Defines how the terminal UIs (dash and otel/trace) copy selected text to the system clipboard on each supported platform, and how they report success or failure to the user.

## ADDED Requirements

### Requirement: Linux clipboard copy supports Wayland and X11 clipboard tools
On Linux, copying text to the system clipboard SHALL attempt both a Wayland clipboard tool (`wl-copy`) and X11 clipboard tools (`xclip`, `xsel`), succeeding if any one of them successfully receives the text. macOS and Windows copy behavior (`pbcopy`, `clip`) SHALL be unaffected.

#### Scenario: Copy succeeds on a Wayland-only session
- **WHEN** the system is running Linux with `wl-copy` available but neither `xclip` nor `xsel` available
- **THEN** the clipboard copy SHALL succeed by using `wl-copy`

#### Scenario: Copy succeeds on an X11-only session
- **WHEN** the system is running Linux with `xclip` or `xsel` available but `wl-copy` unavailable
- **THEN** the clipboard copy SHALL succeed by using the available X11 tool

### Requirement: Clipboard copy falls back to an OSC 52 terminal escape sequence
When no supported clipboard command succeeds (for example, none of `wl-copy`, `xclip`, or `xsel` is installed, or all invocations fail), copying to the clipboard SHALL fall back to writing an OSC 52 clipboard-set escape sequence to the terminal so the copy can still succeed in terminals that support OSC 52, including over SSH or inside `tmux`.

#### Scenario: No clipboard binary is installed
- **WHEN** copying text to the clipboard on Linux and none of the supported clipboard commands are available or all fail
- **THEN** the copy operation SHALL write an OSC 52 escape sequence containing the base64-encoded text to the terminal
- **AND** the copy operation SHALL be reported as successful

#### Scenario: OSC 52 sequence is wrapped for tmux passthrough
- **WHEN** the OSC 52 fallback runs while the process is attached to `tmux`
- **THEN** the escape sequence SHALL be wrapped in the `tmux` passthrough sequence so the outer terminal receives it

### Requirement: Selection-copy actions report accurate success or failure
Every user-facing selection-copy action in the dash TUI and the otel/trace TUI SHALL report success only when the underlying clipboard write actually succeeded, and SHALL report a distinct failure notification when it did not.

#### Scenario: Dash TUI copy failure is reported accurately
- **WHEN** the user copies the current selection in the dash TUI (via a copy key binding or mouse selection) and the underlying clipboard write fails
- **THEN** the dash TUI SHALL show a copy-failed notification
- **AND** the dash TUI SHALL NOT show a copy-succeeded notification for that action

#### Scenario: Dash TUI copy success is reported accurately
- **WHEN** the user copies the current selection in the dash TUI and the underlying clipboard write succeeds
- **THEN** the dash TUI SHALL show a copy-succeeded notification

#### Scenario: Otel TUI copy failure is reported accurately
- **WHEN** the user copies the current selection in the otel/trace TUI and the underlying clipboard write fails
- **THEN** the otel TUI SHALL show a copy-failed notification
- **AND** the otel TUI SHALL NOT show a copy-succeeded notification for that action
