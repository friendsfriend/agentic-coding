## MODIFIED Requirements

### Requirement: Compatibility outlives internal bridges
Current workflow schema v6, current environment schema v9, current JSON config/preferences and current product operations SHALL remain usable after internal bridge deletion. Historical persisted formats SHALL NOT be retained as compatibility shims: they are refused or ignored, never imported or upgraded. The unversioned `/api/*` surface is the current first-party product API rather than an old-format reader, so this change neither renames, removes nor aliases any route.

#### Scenario: Current workflow is opened after cleanup
- **WHEN** the application opens a current v6 workflow store with an exact registered definition pin
- **THEN** it SHALL read and operate on that current-format state without rewriting its schema or pin

#### Scenario: Historical data is refused without mutation
- **WHEN** the application encounters an unsupported workflow or environment schema
- **THEN** it SHALL report or ignore the unsupported format without importing, upgrading, or modifying it

#### Scenario: Current product routes keep serving
- **WHEN** an in-repository caller uses an operation on the unversioned `/api/*` surface
- **THEN** the operation SHALL keep its current behavior, authorization and ordering
- **AND** the surface SHALL stay the current first-party API rather than a compatibility shim for an older data format
