# Spec Delta

## Purpose

A pointer gesture obeys the same structural hierarchy, modal isolation and
Escape ladder the keyboard already follows.

## ADDED Requirements

### Requirement: Pointer navigation respects the page hierarchy

A pointer tap SHALL navigate exactly where the equivalent key navigates: a
breadcrumb segment, a destination row, a location-picker row, a tab or a
section header. That includes the collapsed-ancestor behavior of a bounded
breadcrumb row, and it SHALL NOT change the history stack the keyboard's
Back/Forward pair walks.

#### Scenario: Tapping a breadcrumb ancestor

- **WHEN** the developer taps an ancestor segment in the breadcrumb row
- **THEN** the shell SHALL navigate to that structural ancestor
- **AND** the Back/Forward history SHALL be unchanged

#### Scenario: Tapping a collapsed breadcrumb placeholder

- **WHEN** the row collapsed middle ancestors and the developer taps the placeholder
- **THEN** the keyboard cursor SHALL move into the hidden range exactly as the key does

#### Scenario: Tapping a destination row

- **WHEN** the developer taps a destination row that is already selected
- **THEN** the shell SHALL open that destination as `Enter` would

### Requirement: Modal layers swallow pointer input

While a dialog is open, pointer input SHALL reach only that dialog and the
surfaces it owns; a tap inside the dialog SHALL NOT fall through to the page body
or a second dialog below it, and the page body SHALL NOT change selection,
focus or scroll from a tap while the dialog owns input.

#### Scenario: Tap on the page body under an open dialog

- **WHEN** a dialog is open and the developer taps the page body outside the dialog
- **THEN** the page's selection and panel focus SHALL remain unchanged

#### Scenario: Nested dialog ownership

- **WHEN** a second dialog is open above a first
- **THEN** a tap SHALL act on the topmost dialog only
