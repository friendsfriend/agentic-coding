# tui-shared-primitives Specification

## Purpose
TBD - created by archiving change consolidate-tui-primitives. Update Purpose after archive.
## Requirements
### Requirement: Shared terminal primitive ownership
Equivalent modal framing, panel framing, scrolling, theme-access, search/filter headers, list presentation, semantic highlighting, badge rendering, notification presentation, viewer rendering and selection behavior across environment, workflow, wiki and observability surfaces SHALL have one shared implementation per equivalent primitive. Feature-specific content and wrappers SHALL retain intentional behavior differences without a universal options schema. Shared implementations SHALL NOT import feature modules or backend clients. A shared header or list primitive SHALL render an identity label only while the surrounding chrome does not already name that page, and no shared primitive SHALL carry keybind hint text; keybind discovery SHALL come from the command catalog projections.

#### Scenario: Equivalent consumers use a primitive
- **WHEN** environment, workflow, wiki or observability consumers need equivalent primitive behavior
- **THEN** they SHALL delegate to the same implementation
- **AND** replacement SHALL leave no active duplicate of the migrated equivalent behavior

#### Scenario: Consumers have different behavior contracts
- **WHEN** animated badges, review content, summary layouts or questionnaires differ in lifecycle, layout or actions
- **THEN** those differences SHALL remain composed feature content or supported variants
- **AND** consolidation SHALL NOT erase functionality solely to reduce code

#### Scenario: Temporary wrapper reaches its last caller
- **WHEN** every caller of a compatibility wrapper has migrated
- **THEN** the obsolete wrapper and superseded implementation SHALL be removed

#### Scenario: Identity label with and without surrounding chrome
- **WHEN** the same list or detail primitive renders under page chrome that names the page
- **THEN** its identity label SHALL be omitted while its data columns stay
- **AND** rendered without such chrome it SHALL keep its identity label

#### Scenario: Keys are not advertised in a primitive
- **WHEN** a consumer needs to tell the user which keys accept, cancel or navigate
- **THEN** the keys SHALL be projected from the registered command catalog into the footer or the shared help/modal footer
- **AND** the primitive SHALL NOT paint a bespoke key hint row

### Requirement: Primitive consolidation preserves terminal behavior
Shared primitive migration SHALL preserve existing rendering and interaction contracts for each migrated consumer, including focus, keyboard ownership, stacking, scroll behavior, selection copy, live theme changes, cleanup and feature-specific review payload anchors. Representative consumers from every affected family SHALL be checked at the OpenTUI renderer boundary before their duplicate implementations are deleted.

#### Scenario: Modal is opened and closed
- **WHEN** a migrated modal opens above another modal and then closes
- **THEN** its established z-order, Escape/Enter behavior and focus restoration SHALL remain correct
- **AND** feature content SHALL continue to submit the same validated domain payload

#### Scenario: Narrow terminal scrolls and copies content
- **WHEN** a migrated consumer renders in a narrow terminal and the user scrolls or copies selected content
- **THEN** viewport behavior and selection-copy results SHALL match its previous contract
- **AND** wrapped content SHALL remain accessible without overlapping the scrollbar

#### Scenario: Theme changes or consumer unmounts
- **WHEN** a theme changes while a shared primitive is mounted or its consumer is disposed
- **THEN** theme updates SHALL propagate and owned listeners/timers/animations SHALL be cleaned up
- **AND** one consumer's lifecycle SHALL NOT corrupt another mounted instance

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

