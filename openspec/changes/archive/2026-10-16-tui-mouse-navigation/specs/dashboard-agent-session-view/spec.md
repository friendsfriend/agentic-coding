# Spec Delta

## Purpose

The agent-session page — shared by the dashboard's Agents panel and the Home
Orchestrator page — accepts the pointer without disturbing its transcript,
prompt or toggles.

## ADDED Requirements

### Requirement: Session view pointer parity

The session view SHALL accept the pointer under the shared semantics: the wheel
SHALL scroll the transcript, a tap on the prompt area SHALL focus the prompt
input, a tap on a block row SHALL keep toggling that block, and the view's
picker and filter lists SHALL select on a tap and activate on a tap of the
selected row. Pointer input SHALL NOT change the view's key handling, its input
focus rules or the transcript's selection copy.

#### Scenario: Block toggles stay on tap

- **WHEN** the developer taps a thinking or tool block row
- **THEN** that block SHALL expand or collapse exactly as its key does

#### Scenario: Transcript scroll does not move the prompt

- **WHEN** the developer scrolls the transcript with the wheel
- **THEN** the transcript SHALL move
- **AND** the prompt text, its history position and its focus SHALL remain unchanged

#### Scenario: Picking a history entry

- **WHEN** the developer taps a history or completion row
- **THEN** the row SHALL be selected
- **AND** tapping the selected row SHALL insert it as the key would

#### Scenario: Keyboard session keys are unchanged

- **WHEN** the developer sends, steers, scrolls, toggles and completes with the keyboard
- **THEN** every session key SHALL behave as before
