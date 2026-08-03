## Purpose

Defines where dashboard modal overlays anchor in the `agentic-coding` TUI so dialogs appear centered on the terminal regardless of the layout region they are opened from.

## ADDED Requirements

### Requirement: Dashboard modals center on the terminal
When a dashboard modal opens from the Workflow tab — in home/manager mode or a per-workflow dashboard — its dialog SHALL be centered on the terminal as a whole, and its backdrop SHALL cover the full terminal including the header, tab bar, and status bar.

#### Scenario: New-workflow modal is terminal-centered
- **WHEN** the user opens the new-workflow modal (`n` in home mode)
- **THEN** the modal dialog SHALL be centered relative to the terminal
- **AND** the vertical center of the dialog SHALL be within one row of the terminal's vertical center
- **AND** the backdrop SHALL extend across the full terminal height, including the header, tab bar, and status bar rows

#### Scenario: All shared dash modals centered
- **WHEN** any dashboard modal opened from the Workflow tab (help, error dialog, filter, sort, theme picker, confirm, findings, cost, events, verification timeline, diff view, or list view) is shown
- **THEN** its dialog SHALL be centered on the terminal using the same anchoring as the new-workflow modal
- **AND** no modal dialog SHALL be offset from the terminal center by the chrome height (header, tab bar, status bar)

#### Scenario: Otel modals unaffected
- **WHEN** a modal opens from a non-Workflow tab (traces, metrics, logs, topology)
- **THEN** it SHALL remain centered on the terminal
- **AND** no regression SHALL be introduced to otel-tab modal positioning
