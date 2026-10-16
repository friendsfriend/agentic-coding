# Spec Delta

## Purpose

The Settings screens and the bounded numeric editor accept the pointer, without
changing their persistence or validation behavior.

## ADDED Requirements

### Requirement: Settings accepts pointer input

The Settings section list SHALL select a row on a tap and perform that row's
activation (open the theme picker, navigate, open the numeric editor, reload or
start a browser install) on a tap of the already-selected row. The bounded
numeric editor SHALL focus its field on a tap and expose its accept and cancel
actions as pointer targets. The agent preset view SHALL select and activate its
menu, list, pool and picker rows on tap, focus its text, select and numeric
fields on tap, and keep its destructive confirmation explicit — a backdrop tap
SHALL never confirm a deletion or discard a draft.

#### Scenario: Activating a section row

- **WHEN** the developer taps a Settings row that is already selected and the row performs an action
- **THEN** the same action SHALL run once
- **AND** a read-only row SHALL select without performing an action

#### Scenario: Numeric editor draft

- **WHEN** the developer taps outside the bounded numeric editor while it holds an edited value
- **THEN** the editor SHALL stay open with the value unchanged
- **AND** its field, accept and cancel targets SHALL respond to taps

#### Scenario: Preset view delete confirmation

- **WHEN** the developer taps outside a pending delete confirmation in the agent preset view
- **THEN** no deletion SHALL happen
- **AND** the confirmation SHALL remain until an explicit control confirms or cancels it

#### Scenario: Settings keyboard behavior is unchanged

- **WHEN** the developer navigates, activates, reloads and edits with the keyboard
- **THEN** every Settings key SHALL behave as before
- **AND** saved values, scopes and validation messages SHALL be unchanged
