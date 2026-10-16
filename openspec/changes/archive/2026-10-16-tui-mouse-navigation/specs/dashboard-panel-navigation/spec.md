# Spec Delta

## Purpose

The dashboard panel grid gains the pointer equivalent of its focus and
selection keys.

## ADDED Requirements

### Requirement: Pointer focus and selection in the panel grid

Tapping a rendered panel SHALL focus it exactly as the panel-navigation keys do,
and tapping a selectable row inside a panel SHALL select it in that panel and
move panel focus to that panel. A panel row whose `Enter` action exists SHALL
activate on a tap of the already-selected row. Panel focus SHALL change on a tap
only when the panel was not already focused, and a tap SHALL NOT change the
scroll offset of any other panel.

#### Scenario: Tapping an unfocused panel

- **WHEN** the developer taps a rendered panel other than the focused one
- **THEN** panel focus SHALL move to that panel
- **AND** the footer SHALL show that panel's key context

#### Scenario: Tapping a row in another panel

- **WHEN** the developer taps a selectable row inside a panel that does not hold focus
- **THEN** the row SHALL be selected and that panel SHALL take focus

#### Scenario: Tapping a row in a panel with an Enter action

- **WHEN** the developer taps the row that is already selected in a panel whose `Enter` opens or reviews something
- **THEN** the same action SHALL run

#### Scenario: Tapping a read-only panel row

- **WHEN** the developer taps a row in a panel with no `Enter` action
- **THEN** the row SHALL be selected
- **AND** no other action SHALL run

#### Scenario: Keyboard panel navigation is unchanged

- **WHEN** the developer moves panel focus and the local list cursor with the keyboard after this change
- **THEN** every key SHALL behave as before
