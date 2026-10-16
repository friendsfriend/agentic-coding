# Spec Delta

## Purpose

The workflow dashboard's dialogs, and the agent-session page it opens, accept
the pointer with the same semantics as the rest of the TUI.

## ADDED Requirements

### Requirement: Dashboard dialogs accept the pointer

Every dashboard dialog SHALL accept pointer input under the shared semantics
when it renders a selectable list, an option list, tabs or a footer of key
chips: a tap selects, a tap on the already-selected row performs the dialog's
`Enter` action, and a footer chip runs its argument-free command. Dialogs that
hold typed input, a secret, a running operation or an irreversible action SHALL
NOT be dismissed by a backdrop tap.

#### Scenario: Option list in a dialog

- **WHEN** the developer taps an option row that is not selected in a dashboard dialog
- **THEN** that option SHALL become the selected one
- **AND** tapping it again SHALL perform the dialog's `Enter` action

#### Scenario: Read-only detail dialog

- **WHEN** the developer scrolls a read-only detail dialog with the wheel and taps
- **THEN** the dialog SHALL scroll on the wheel
- **AND** a backwards tap outside the dialog SHALL close it where `Escape` does

#### Scenario: Wizard keeps its draft

- **WHEN** the developer taps outside the new-workflow wizard while a field holds typed text
- **THEN** the wizard SHALL stay open with its draft and step unchanged
- **AND** the field SHALL be reachable by tapping it

#### Scenario: Footer chips in a dialog

- **WHEN** the developer taps a footer chip whose key is available
- **THEN** the same command the key runs SHALL run once

### Requirement: Agent session page accepts the pointer

The agent-session page SHALL accept the pointer: the wheel SHALL scroll the
transcript, a tap on the prompt area SHALL focus the prompt input, block rows
SHALL keep toggling on tap, and the page's picker and filter lists SHALL select
and activate as their keys do.

#### Scenario: Wheel scrolls the transcript

- **WHEN** the developer moves the wheel over the session transcript
- **THEN** the transcript SHALL scroll
- **AND** the prompt input SHALL keep its own content and focus state

#### Scenario: Tapping the prompt focuses it

- **WHEN** the developer taps the prompt area
- **THEN** the prompt input SHALL take text focus as the keyboard path would give it

#### Scenario: Tapping a picker row

- **WHEN** the developer taps a row in the session's picker or filter list
- **THEN** the row SHALL be selected
- **AND** tapping the selected row SHALL perform the picker's `Enter` action
