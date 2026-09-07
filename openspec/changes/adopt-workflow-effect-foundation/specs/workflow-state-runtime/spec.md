## ADDED Requirements

### Requirement: Schema adoption preserves workflow compatibility
Workflow command, snapshot, dialogue, and built-in step input/output decoding SHALL use one Effect Schema-backed implementation per contract while preserving supported acceptance/rejection behavior, normalization, serialized data, contract IDs/versions, and historical definition/step digests. Pure cross-field validation SHALL remain enforced. Schema implementation metadata SHALL not enter durable pins or wire values.

#### Scenario: Historical workflow loads through Schema
- **WHEN** a supported historical snapshot is decoded after migration
- **THEN** it SHALL retain the same normalized domain data and resolvable semantic pins
- **AND** it SHALL not require repin or a data migration solely because the parser implementation changed

#### Scenario: Invalid input is decoded
- **WHEN** a command or artifact violates an existing size, identity, shape, or cross-field rule
- **THEN** Schema-backed decoding SHALL reject it before any workflow mutation or capability consumption

#### Scenario: Legacy optional fields are absent
- **WHEN** recognized legacy data omits an optional field or uses an explicitly supported null/default form
- **THEN** decoding and subsequent serialization SHALL preserve the established compatibility behavior

#### Scenario: Contract implementation changes
- **WHEN** a registered step switches from its old parser implementation to Schema with equivalent behavior
- **THEN** its contract identity and historical step/definition digests SHALL remain unchanged

#### Scenario: Compatibility facade remains during migration
- **WHEN** an existing caller invokes a temporary synchronous parse facade
- **THEN** the facade SHALL delegate to the same Schema contract rather than maintain an independent validator
