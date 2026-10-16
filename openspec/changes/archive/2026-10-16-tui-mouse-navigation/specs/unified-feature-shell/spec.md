# Spec Delta

## Purpose

The shell chrome — workspace sidebar, tabs, breadcrumbs, footer chips and
destination lists — is fully pointer-reachable under one shared semantics.

## ADDED Requirements

### Requirement: Shell chrome is pointer-reachable

The workspace sidebar rows, the tab and section strip, the breadcrumb row, the destination lists, the location picker and the footer key chips SHALL be pointer targets.
Their behavior follows the shared semantics: a tap selects, a tap on the selected
row opens, a tab or section header switches on a tap, and a footer chip runs its
registered command when that command takes no argument and is available. A tap
on the sidebar as a whole SHALL focus the sidebar panel. Pointer input SHALL NOT
change the shell's navigation history, its modal stack, its input isolation or
any key binding.

#### Scenario: Opening a workflow from the sidebar

- **WHEN** the developer taps a workflow row that is not selected and then taps it again
- **THEN** the first tap SHALL select the row
- **AND** the second tap SHALL open that workflow's dashboard as `Enter` does

#### Scenario: Tapping the sidebar focuses it

- **WHEN** the developer taps the sidebar panel while the page body holds focus
- **THEN** the sidebar SHALL take panel focus
- **AND** the body SHALL keep its state

#### Scenario: Footer chip runs a shell command

- **WHEN** the developer taps a footer chip for an available argument-free command
- **THEN** that command SHALL run once
- **AND** a chip with no available command SHALL do nothing

#### Scenario: Pointer input stays isolated while a dialog owns input

- **WHEN** a shell dialog is open and the developer taps the page body
- **THEN** the sidebar and the body SHALL keep their selection and focus unchanged

#### Scenario: Existing shell keys and catalog are unchanged

- **WHEN** the footer and help modal are opened after this change
- **THEN** they SHALL list the same keybindings as before
- **AND** every shell key SHALL behave as before

### Requirement: Embedded Environments feature accepts pointer input

The Environments feature SHALL accept the pointer across the surfaces it
embeds: its tab and section strip, its tables and list views, its detail views,
its slot and action views and its dialogs. Table and list rows SHALL select on a
tap and open their detail on a tap of the selected row; detail, log, diff and
markdown panes SHALL scroll on the wheel; dialog rows and tabs SHALL follow the
shared semantics; and dialogs holding typed input, a passphrase, a running
operation or an irreversible confirmation SHALL NOT be dismissed by a backdrop
tap. Text selection and copy inside its diff and markdown views SHALL remain
unaffected.

#### Scenario: Opening a detail from a table

- **WHEN** the developer taps a table row and then taps it again
- **THEN** the first tap SHALL select the row
- **AND** the second tap SHALL open the same detail the row's key opens

#### Scenario: Scrolling a detail or log pane

- **WHEN** the developer moves the wheel over a detail, log, diff or markdown pane
- **THEN** that pane SHALL scroll
- **AND** no other pane's offset or selection SHALL change

#### Scenario: Guarded environment dialog

- **WHEN** the developer taps outside a passphrase, typed-comment or confirmation dialog
- **THEN** the dialog SHALL stay open
- **AND** its input SHALL remain unchanged

#### Scenario: Dragging inside a diff view selects text

- **WHEN** the developer drags across lines in a diff or markdown review view
- **THEN** the drag SHALL keep selecting text
- **AND** no row SHALL be selected or activated by the gesture

#### Scenario: Environment keys are unchanged

- **WHEN** the developer navigates, opens, filters, sorts and confirms with the keyboard
- **THEN** every environment key SHALL behave as before
