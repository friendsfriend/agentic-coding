# Spec Delta

## Purpose

One definition of pointer behavior for the terminal UI, so every screen, panel,
modal, list, tab and button a developer can reach with the keyboard is also
reachable with the mouse, with the same result and without changing any key
binding.

## ADDED Requirements

### Requirement: One shared pointer semantics

The TUI SHALL implement pointer behavior once in the shared UI package and
every surface SHALL use it; surfaces SHALL NOT carry their own click resolution,
their own double-click detection or their own wheel arithmetic. A tap SHALL mean
select for an unselected row, activate for the already-selected row where the
surface activates rows, and nothing elsewhere. A double tap SHALL select and
then activate exactly once. Pointer buttons other than a left tap and a wheel
SHALL be ignored. No surface SHALL install a pointer-move handler or maintain
hover state.

#### Scenario: Tap selects an unselected row

- **WHEN** the developer taps a list row that is not the selected one
- **THEN** that row SHALL become the selected row
- **AND** no activation SHALL run

#### Scenario: Tap on the selected row activates it

- **WHEN** the developer taps the row that is already selected and the surface activates rows
- **THEN** the surface SHALL perform the same action `Enter` performs on that row

#### Scenario: Double tap activates once

- **WHEN** the developer taps the same row twice within the double-tap window
- **THEN** the row SHALL be selected and activated exactly once
- **AND** a later keyboard `Enter` SHALL NOT be able to repeat the activation from a stale tap

#### Scenario: A tap where no row exists changes nothing

- **WHEN** the developer taps a border, padding or empty area inside a pane
- **THEN** selection, focus and scroll SHALL remain unchanged

#### Scenario: Unsupported pointer buttons are ignored

- **WHEN** a right, middle or otherwise non-primary pointer event reaches a surface
- **THEN** it SHALL NOT select, activate, scroll or dismiss anything

### Requirement: Pointer scrolling targets the pane under the pointer

A wheel event SHALL scroll the innermost scrollable pane under the pointer, not
the focused pane, and SHALL NOT change focus or selection. Lists whose keyboard
scroll moves the selection SHALL keep that behavior through the pointer.

#### Scenario: Wheel over an unfocused pane

- **WHEN** the pointer rests over a scrollable pane that does not hold focus and the wheel moves
- **THEN** that pane SHALL scroll
- **AND** the focused pane, its offset and the selection SHALL remain unchanged

#### Scenario: Wheel over a pane with no scroll owner

- **WHEN** the pointer rests over a pane whose content fits
- **THEN** the wheel event SHALL change nothing

### Requirement: Pointer access to chrome and controls

Panels, tabs, section headers, breadcrumb segments, list rows and footer key chips SHALL be pointer targets.
A chip SHALL run its registered command only
when that command takes no argument and is currently available, so a chip never
performs something its key would not perform in the current state. Tapping a
panel SHALL focus it exactly as the panel-navigation keys do.

#### Scenario: Tapping a panel focuses it

- **WHEN** the developer taps a panel that does not hold panel focus
- **THEN** panel focus SHALL move to that panel
- **AND** its key-scoped help context SHALL become the active one

#### Scenario: Tapping an available chip runs its command

- **WHEN** the developer taps a footer or modal key chip whose key is available and takes no argument
- **THEN** the same command the key would run SHALL run once

#### Scenario: Tapping an unavailable or argument-taking chip

- **WHEN** the chip's command is unavailable in the current state or requires a typed argument or a row selection
- **THEN** the tap SHALL change nothing

### Requirement: Pointer dismissal matches the Escape contract

A tap on a modal backdrop or on a close control SHALL dismiss a dialog exactly
where `Escape` is a non-destructive dismissal, and SHALL NOT dismiss a dialog
that holds unsaved typed input, a secret, a running operation, or an
irreversible action. The policy for each dialog SHALL be recorded once in the
shared layer rather than decided per dialog at the call site.

#### Scenario: Backdrop tap closes a read-only dialog

- **WHEN** the developer taps outside a read-only dialog whose `Escape` closes it
- **THEN** the dialog SHALL close with the same result `Escape` produces

#### Scenario: Backdrop tap never discards typed input

- **WHEN** the developer taps outside a dialog holding typed draft text, a secret, or a confirmation for an irreversible action
- **THEN** the dialog SHALL stay open
- **AND** its draft value SHALL remain unchanged

#### Scenario: Taps inside a dialog do not reach what is behind it

- **WHEN** the developer taps a control inside an open dialog
- **THEN** only that control SHALL act
- **AND** no hidden or covered surface below SHALL receive the tap

### Requirement: Pointer hit testing respects layers, offsets and hidden regions

Taps SHALL be resolved against the rendered row or control under the pointer
with the list's real scroll offset, so a scrolled window selects the row the
developer sees. A region that is not visible SHALL NOT receive a tap.

#### Scenario: Tap after scrolling a windowed list

- **WHEN** the developer scrolls a windowed list and taps a visible row
- **THEN** the row under the pointer SHALL be selected
- **AND** no off-window index SHALL be selected in its place

#### Scenario: Tap over a hidden surface

- **WHEN** a surface is mounted but hidden behind the page that took its place
- **THEN** taps over the hidden surface's area SHALL NOT change its selection or focus

### Requirement: Surfaces stay keyboard-first and mouse-additive

Mouse handling SHALL NOT remove, rename or reorder any key binding, and every
keyboard path SHALL keep working unchanged.

#### Scenario: Existing keys still work

- **WHEN** the developer navigates, activates, dismisses and scrolls with the keyboard after this change
- **THEN** every key SHALL behave as it did before

### Requirement: Pointer parity covers every interaction surface

The change SHALL record an inventory of the TUI's screens, panels, modals,
lists, tabs and buttons with their keyboard actions, their previous pointer
support and the affordance each gains, and SHALL apply the shared semantics to
every inventoried item. Surfaces that are pointer-reachable SHALL keep a
keyboard/pointer parity check where practical.

#### Scenario: Inventory covers every surface family

- **WHEN** the change is reviewed
- **THEN** the inventory SHALL list the shell chrome, the workflow dashboard and
  its modals and panels, the agent-session page, the Orchestrator page, the
  Environments feature, the Settings screens, the observability tabs and the
  Wiki view
- **AND** every listed item SHALL name its keyboard actions, its previous
  pointer support and its affordance

#### Scenario: Parity is asserted for a surface

- **WHEN** a surface's parity test performs an action with the pointer and with the key
- **THEN** the resulting state SHALL be identical

### Requirement: Pointer capability is established against the renderer

The change SHALL establish, from the installed renderer package and a renderer
test, which pointer events the TUI actually receives, and SHALL adapt the
semantics to what exists rather than assume a capability.

#### Scenario: Renderer reports its pointer events

- **WHEN** the shared layer is implemented
- **THEN** the available pointer events, their payload fields and their
  propagation behavior SHALL be recorded, with a renderer test proving a tap
  reaches a row
