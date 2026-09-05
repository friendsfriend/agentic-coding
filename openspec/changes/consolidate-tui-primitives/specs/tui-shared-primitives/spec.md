## ADDED Requirements

### Requirement: Shared terminal primitive ownership
Equivalent modal-shell, scrolling, theme-access, and selection behavior used across dashboard and observability surfaces SHALL have one shared implementation per equivalent primitive. Feature-specific wrappers SHALL retain intentional behavior differences rather than force all consumers through a universal options schema. Shared implementations SHALL not import dashboard or observability feature modules.

#### Scenario: Equivalent consumers use a primitive
- **WHEN** dashboard and observability consumers need equivalent primitive behavior
- **THEN** both SHALL delegate that behavior to the same shared implementation
- **AND** replacement of their prior implementations SHALL leave no active duplicate of that equivalent behavior

#### Scenario: Consumers have different behavior contracts
- **WHEN** an animated badge or feature modal differs in lifecycle, layout, input ownership, or content behavior
- **THEN** its feature-specific behavior SHALL remain in a wrapper or separate implementation
- **AND** consolidation SHALL not erase that difference solely to reduce code

### Requirement: Primitive consolidation preserves terminal behavior
Shared primitive migration SHALL preserve existing rendering and interaction contracts for each migrated consumer, including focus, keyboard ownership, stacking, scroll behavior, selection copy, live theme changes, and cleanup. Representative consumers from each affected component family SHALL be checked at the OpenTUI renderer boundary.

#### Scenario: Modal is opened and closed
- **WHEN** a migrated modal opens above another modal and then closes
- **THEN** its established z-order, Escape/Enter behavior, and focus restoration SHALL remain unchanged

#### Scenario: Narrow terminal scrolls and copies content
- **WHEN** a migrated consumer renders in a narrow terminal and the user scrolls or copies selected content
- **THEN** viewport behavior and selection-copy results SHALL match its previous contract
- **AND** hidden content SHALL not become inaccessible because of consolidation

#### Scenario: Theme changes or consumer unmounts
- **WHEN** a theme changes while a shared primitive is mounted or its consumer is disposed
- **THEN** theme updates SHALL propagate as before and owned listeners/timers/animations SHALL be cleaned up
- **AND** one consumer's lifecycle SHALL not corrupt another mounted instance
