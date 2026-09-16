## MODIFIED Requirements

### Requirement: Structural hierarchy differs from history
Breadcrumbs and Parent SHALL derive from route hierarchy. Escape SHALL perform the structural Parent step of the current location and SHALL be a no-op at Home. Chronological Back and Forward SHALL restore prior and next locations across any number of feature boundaries, including their valid view state, and SHALL be bound to `Ctrl+O`/`Ctrl+I` with `Alt+Left`/`Alt+Right` as equivalent bindings that work on every terminal. `Ctrl+I` SHALL NOT also act as `Tab`. Modal opening and filter edits SHALL NOT add page history. Home SHALL have no parent and Escape at Home SHALL NOT quit.

#### Scenario: Cross-domain back and parent
- **WHEN** a user opens a trace from an application page
- **THEN** Escape SHALL open its structural observability ancestor
- **AND** `Ctrl+O` from the trace SHALL instead restore the originating application page

#### Scenario: Multiple domains
- **WHEN** a user visits an application, a trace and then Wiki
- **THEN** successive `Ctrl+O` operations SHALL restore the trace and then the application rather than losing the earlier origin

#### Scenario: Forward after Back
- **WHEN** a user goes back with `Ctrl+O` and then presses `Ctrl+I`
- **THEN** the location left by the Back SHALL be restored with its view state
- **AND** a new navigation after a Back SHALL discard the forward locations

#### Scenario: Terminal cannot distinguish Ctrl+I
- **WHEN** the terminal delivers `Ctrl+I` and `Tab` as the same key and the user presses it
- **THEN** the key SHALL keep its focus-cycling meaning
- **AND** Back and Forward SHALL remain reachable through `Alt+Left` and `Alt+Right`

#### Scenario: Up-step inside a feature body
- **WHEN** the embedded environment feature is at its own navigation root and the user presses Escape
- **THEN** the shell SHALL perform the page hierarchy step instead of the feature consuming the key
- **AND** a deeper feature view mode SHALL still close one level of its own view stack

### Requirement: One location picker and bounded breadcrumbs
The location picker SHALL support keyboard search and selection of known destinations, ancestors and siblings. Breadcrumb navigation SHALL share the same routing operations. A breadcrumb segment SHALL name the resource its route renders whenever the route names one (environment resource, trace, span, log, metric, note, workflow), so the row identifies the current location without a separate title line. Narrow rendering SHALL preserve current-location identification and access to collapsed ancestors without horizontal overflow, truncating a resource label rather than overflowing the row.

#### Scenario: Jump directly
- **WHEN** the user selects Metrics in the location picker
- **THEN** Metrics SHALL open without first traversing Home and Observability manually
- **AND** `Ctrl+O` SHALL return to the pre-picker page

#### Scenario: Resource page names itself
- **WHEN** the user opens a log, metric, span or wiki note page
- **THEN** the breadcrumb's current segment SHALL name that resource
- **AND** the page SHALL NOT repeat the identity in a separate title row

## ADDED Requirements

### Requirement: One ordered Escape ladder
Escape SHALL be handled by exactly one ordered ladder, evaluated innermost level first: global error modal, quit confirmation, modal help over a dialog, contextual wizard step, top modal, breadcrumb focus, text-input mode, page hierarchy. The first level that consumes the key SHALL stop the ladder. A level SHALL NOT close a location when an inner level is active, and no chrome, footer or body row SHALL restate the ladder as prose.

#### Scenario: Escape inside a text-input mode
- **WHEN** the user presses Escape while a page's search input is active
- **THEN** the input SHALL be cancelled and the previous query restored
- **AND** the page SHALL NOT leave the current location

#### Scenario: Escape with breadcrumb focus
- **WHEN** the user presses Escape while the breadcrumb row owns focus
- **THEN** focus SHALL return to the page body
- **AND** a second Escape SHALL perform the page hierarchy step

#### Scenario: Escape at Home
- **WHEN** the user presses Escape at Home
- **THEN** nothing SHALL change and the application SHALL NOT quit
