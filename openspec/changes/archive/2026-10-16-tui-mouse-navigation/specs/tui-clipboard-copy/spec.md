# Spec Delta

## Purpose

Pointer gestures must not disturb selecting and copying text in transcripts,
markdown and diff views.

## ADDED Requirements

### Requirement: A pointer drag is never a row interaction

A pointer interaction SHALL count as a row tap only when the press and the
release land on the same row at the same cell. A drag SHALL keep its existing
meaning — selecting text — and SHALL NOT select, activate, focus or dismiss
anything, including when the release lands on a different row than the press.

#### Scenario: Dragging across rows selects text

- **WHEN** the developer presses on one row, moves the pointer over other rows and releases
- **THEN** the pointer SHALL NOT change the selected row
- **AND** the released gesture SHALL remain available to the selection-copy path

#### Scenario: Copying a selection still works after a drag

- **WHEN** the developer drags a selection inside a transcript or markdown view and invokes copy
- **THEN** the copied text SHALL be the dragged selection
- **AND** no click handler SHALL have consumed the gesture

#### Scenario: A press and release on the same row is a tap

- **WHEN** the developer presses and releases on the same row at the same cell
- **THEN** the gesture SHALL be treated as a row tap
