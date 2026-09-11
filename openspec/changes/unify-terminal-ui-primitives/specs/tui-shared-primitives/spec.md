## MODIFIED Requirements

### Requirement: Shared terminal primitive ownership
Equivalent modal framing, panel framing, scrolling, theme-access, search/filter headers, list presentation, semantic highlighting, badge rendering, notification presentation, viewer rendering and selection behavior across environment, workflow, wiki and observability surfaces SHALL have one shared implementation per equivalent primitive. Feature-specific content and wrappers SHALL retain intentional behavior differences without a universal options schema. Shared implementations SHALL NOT import feature modules or backend clients.

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
