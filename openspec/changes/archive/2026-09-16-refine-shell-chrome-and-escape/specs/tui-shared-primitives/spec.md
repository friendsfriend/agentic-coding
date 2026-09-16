## MODIFIED Requirements

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
