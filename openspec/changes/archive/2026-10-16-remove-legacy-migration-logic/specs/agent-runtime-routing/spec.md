## MODIFIED Requirements

### Requirement: Pinned non-secret execution settings
Workflow creation SHALL persist the accepted non-secret settings required by later configuration-sensitive effects, including the delivery remote and PR executable selection or its explicit unavailability. Later effects SHALL use those settings rather than rereading the drainer's ambient configuration. Credentials SHALL not be persisted in this record. The runtime SHALL NOT adopt or migrate missing settings from an older workflow format.

#### Scenario: Delivery configuration changes after start
- **WHEN** configuration changes or another process drains an already-started workflow from another directory
- **THEN** delivery and PR effects SHALL retain that workflow's accepted settings
- **AND** no new remote or executable SHALL be selected implicitly

#### Scenario: Current workflow settings are absent
- **WHEN** a current-format workflow lacks a required execution setting
- **THEN** the affected effect SHALL stop with a clear validation diagnostic
- **AND** status SHALL remain readable without choosing or persisting settings on the user's behalf
