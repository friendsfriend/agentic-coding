# hierarchical-tui-navigation Specification

## Purpose
TBD - created by archiving change replace-nested-tabs-with-page-navigation. Update Purpose after archive.
## Requirements
### Requirement: Category pages replace navigation tab bars
The full application SHALL open Home by default and SHALL render selectable category pages, one breadcrumb row and a location picker instead of shell or nested navigation tab bars. Environments SHALL expose Applications, Libraries, Infrastructure, Scripts and Kubernetes. Observability SHALL expose its enabled Traces, Metrics, Logs and Topology destinations. Existing operational child views SHALL remain reachable through pages.

#### Scenario: Open application
- **WHEN** a user enters Environments, Applications and a configured application
- **THEN** the application page SHALL open with its stable identity and breadcrumbs through those ancestors
- **AND** no outer or inner navigation tab bar SHALL render

#### Scenario: Restricted telemetry launch
- **WHEN** a supported launch option restricts observability views
- **THEN** category pages and the location picker SHALL consistently exclude restricted views without hiding unrelated Wiki access

### Requirement: Structural hierarchy differs from history
Breadcrumbs and Parent SHALL derive from route hierarchy. Back SHALL restore chronological prior locations across any number of feature boundaries, including their valid view state. Modal opening and filter edits SHALL NOT add page history. Home SHALL have no parent and Escape at Home SHALL NOT quit.

#### Scenario: Cross-domain back and parent
- **WHEN** a user opens a trace from an application page
- **THEN** Parent SHALL open its structural observability ancestor
- **AND** Back from the trace SHALL instead restore the originating application page

#### Scenario: Multiple domains
- **WHEN** a user visits an application, a trace and then Wiki
- **THEN** successive Back operations SHALL restore the trace and then the application rather than losing the earlier origin

### Requirement: One location picker and bounded breadcrumbs
The location picker SHALL support keyboard search and selection of known destinations, ancestors and siblings. Breadcrumb navigation SHALL share the same routing operations. Narrow rendering SHALL preserve current-location identification and access to collapsed ancestors without horizontal overflow.

#### Scenario: Jump directly
- **WHEN** the user selects Metrics in the location picker
- **THEN** Metrics SHALL open without first traversing Home and Observability manually
- **AND** Back SHALL return to the pre-picker page

### Requirement: Page-local state and input isolation
Returning to a page SHALL restore valid selected resource identity, search, filters, sort, scroll, focus and unsaved drafts. Missing resources SHALL fall back to the nearest valid ancestor with a diagnostic. Top overlays and text input SHALL take precedence over navigation; inactive pages SHALL NOT process input. Tab and Shift+Tab SHALL traverse local focus regions rather than select destinations.

#### Scenario: Return after refresh
- **WHEN** the user returns to a filtered application list after its ordering changes
- **THEN** selection SHALL follow the selected resource ID rather than the prior row index

#### Scenario: Selection was removed
- **WHEN** a requested resource no longer exists
- **THEN** navigation SHALL show its nearest valid ancestor and explain the unavailable resource without substituting another identity

#### Scenario: Modal consumes Escape
- **WHEN** Escape closes help over an input dialog
- **THEN** that dialog SHALL regain its draft and focus without navigating the underlying page

