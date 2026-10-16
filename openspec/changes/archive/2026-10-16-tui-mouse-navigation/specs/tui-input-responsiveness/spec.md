# Spec Delta

## Purpose

Pointer handling must stay inside the TUI's existing input-performance budget.

## ADDED Requirements

### Requirement: Pointer handling adds no per-move render work

Pointer handling SHALL perform no work while the pointer only moves: no pointer
move handler, no hover state, no highlight update and no layout measurement.
A tap SHALL perform at most the state update its equivalent key performs, and a
wheel event SHALL update only the offset of the pane that handled it. Pointer
handling SHALL NOT start a timer, subscription, watcher or poll of its own, and
double-tap timing SHALL be evaluated at the tap itself rather than scheduled.

#### Scenario: Moving the pointer over a list renders nothing

- **WHEN** the pointer moves across rows of a rendered list without a press
- **THEN** no component state SHALL change and no frame SHALL be scheduled by the pointer path

#### Scenario: One tap is one state update

- **WHEN** the developer taps a row
- **THEN** the surface SHALL update selection at most once
- **AND** the update SHALL be the same one the equivalent key performs

#### Scenario: A wheel event touches only its pane

- **WHEN** the wheel scrolls a pane under the pointer
- **THEN** only that pane's offset SHALL change
- **AND** no refresh, read or observation SHALL be triggered by the wheel

#### Scenario: Pointer handling does not block input

- **WHEN** a tap or wheel resolves while a slow observation is in flight
- **THEN** keyboard input and rendering SHALL continue to settle
- **AND** the pointer path SHALL NOT await the observation
