# Spec Delta

## ADDED Requirements

### Requirement: Preset editor plan-complexity assignments

The Settings preset editor SHALL allow a preset to assign a profile to each plan-complexity category (`easy`, `medium`, `hard`, `critical`) that the workflow classifier vocabulary exposes, while preserving the existing preset routing format and every assignment outside those fields. Each category SHALL be independently optional: an unset category SHALL not be persisted and SHALL not prevent saving a preset used by workflows that do not classify complexity.

#### Scenario: Editor offers every exposed complexity category

- **WHEN** a user opens the stored-preset editor on the complexity-assignment fields
- **THEN** the editor SHALL offer one choice field per exposed plan-complexity category
- **AND** each field's choices SHALL be the saved profile names plus an unset choice
- **AND** it SHALL offer no field for a category the workflow vocabulary does not expose

#### Scenario: Selected complexity mappings persist

- **WHEN** a user assigns profiles to one or more complexity categories and confirms the preset
- **THEN** the persisted preset SHALL contain a flat category key naming the selected profile for each assigned category
- **AND** categories left unset SHALL not be written

#### Scenario: Stored complexity mappings survive an edit

- **WHEN** a user opens a preset that already maps complexity categories, changes an unrelated field, and confirms
- **THEN** every previously stored complexity mapping SHALL remain unchanged in the persisted preset

#### Scenario: A profile referenced only by a complexity mapping is protected

- **WHEN** a user attempts to delete or rename a profile that is referenced only by a preset's complexity mapping
- **THEN** the action SHALL be refused
- **AND** the refusal SHALL identify the referencing preset category entry
