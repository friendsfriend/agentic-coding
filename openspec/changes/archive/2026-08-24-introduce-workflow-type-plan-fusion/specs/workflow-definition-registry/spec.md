## MODIFIED Requirements

### Requirement: Plugin-grade built-in registry seam
Built-in steps and workflows SHALL register through same public definition contract reserved for future trusted workflow plugins, while this release SHALL NOT automatically discover or execute external workflow plugin code.

#### Scenario: Built-in workflows initialize
- **WHEN** engine starts
- **THEN** standard, direct-apply, no-OpenSpec, and plan-fusion definitions SHALL be registered through public registry contract
- **AND** engine SHALL validate them identically to later registered definitions

#### Scenario: External package is present
- **WHEN** an unconfigured package or file exports workflow definitions
- **THEN** engine SHALL NOT load or execute it automatically
- **AND** no filesystem discovery order SHALL affect registered workflows
