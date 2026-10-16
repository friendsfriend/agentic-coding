# Spec Delta

## Purpose

The Home Orchestrator page accepts the pointer on its transcript and prompt,
with the smallest possible change to a surface other workflows are editing.

## ADDED Requirements

### Requirement: Orchestrator page accepts pointer input

The Orchestrator page SHALL accept the pointer: the wheel SHALL scroll its
transcript, a tap on the prompt area SHALL focus the prompt input, a tap on a
transcript block row SHALL keep toggling that block, and the page's model or
thinking picker SHALL select on a tap and activate on a tap of the selected row.
Pointer input SHALL NOT change the page's key handling, its session lifecycle,
its monitoring behavior or the transcript's selection copy, and SHALL add no
per-move handler.

#### Scenario: Scrolling the orchestrator transcript

- **WHEN** the developer moves the wheel over the transcript
- **THEN** the transcript SHALL scroll
- **AND** the session, its subscription state and the prompt SHALL remain unchanged

#### Scenario: Focusing the orchestrator prompt

- **WHEN** the developer taps the prompt area
- **THEN** the prompt input SHALL take text focus
- **AND** no send SHALL happen without the send key or the send control

#### Scenario: Orchestrator picker row

- **WHEN** the developer taps a row in the model or thinking picker
- **THEN** the row SHALL be selected
- **AND** tapping the selected row SHALL apply it as `Enter` does

#### Scenario: Keyboard page behavior is unchanged

- **WHEN** the developer sends, scrolls, toggles, opens a picker and leaves the page with the keyboard
- **THEN** every Orchestrator key SHALL behave as before
