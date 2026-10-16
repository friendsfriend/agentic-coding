# Spec Delta

## Purpose

The pointer layer is a shared primitive: one implementation, used by every
surface, with family entry points that re-export instead of forking.

## ADDED Requirements

### Requirement: Shared mouse interaction ownership

Pointer interaction SHALL be a shared primitive family with one implementation
in the shared UI package, covering row tap resolution, double-tap timing,
wheel-to-pane scrolling, region focus on tap, and the dialog dismissal policy.
Dashboard, observability, wiki and environment consumers SHALL delegate to that
implementation; a family entry point SHALL re-export it rather than restate it,
and no surface SHALL keep a private click resolution or wheel arithmetic.

#### Scenario: Equivalent consumers share the double-tap rule

- **WHEN** a dashboard row, an observability row and an environment row are each double-tapped
- **THEN** all three SHALL resolve the gesture through the same implementation
- **AND** the same double-tap window SHALL apply

#### Scenario: Family entry points re-export

- **WHEN** a family entry point exposes the mouse primitive
- **THEN** it SHALL be the same function object as the shared implementation
- **AND** no family SHALL hold a second copy of the semantics

#### Scenario: A surface needs a different activation

- **WHEN** a surface needs different activation behavior
- **THEN** the difference SHALL be a property of the shared primitive's props
- **AND** it SHALL NOT fork the primitive or duplicate the selection rule

### Requirement: Shared mouse primitives preserve existing rendering contracts

Adding pointer support to a shared primitive SHALL preserve its existing
rendering, focus, keyboard, stacking, scroll and selection-copy contracts, and
SHALL be verified at the OpenTUI renderer boundary with pointer input.

#### Scenario: Row primitive keeps keyboard behavior

- **WHEN** a list built on the shared row primitive is navigated and activated with the keyboard after the pointer support is added
- **THEN** selection, activation and rendering SHALL match the previous behavior

#### Scenario: Modal keeps focus restoration

- **WHEN** a dialog is dismissed by a backdrop tap
- **THEN** focus restoration, stacking and the Escape behavior SHALL match the previous contract
