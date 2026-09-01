## MODIFIED Requirements

### Requirement: Default workflow type preserves existing behavior
The system SHALL default start to the pinned `openspec-full` definition when no workflow definition is supplied.

#### Scenario: Default start is standard
- **WHEN** developer starts workflow without `--workflow`
- **THEN** engine SHALL validate the `openspec-full` definition and begin planning run
- **AND** it SHALL not infer workflow type from presence of modules or phases

#### Scenario: Legacy workflow backward compatibility
- **WHEN** valid legacy state has no workflow type or modules
- **THEN** migration SHALL map it to the pinned `openspec-full` definition only when phase/evidence are consistent
- **AND** otherwise expose repair-required state

### Requirement: Dashboard displays no-openspec workflow
Dashboard SHALL display pinned no-OpenSpec definition and engine-provided step/run/action view, using the `No OpenSpec` UI label and its workflow description.

#### Scenario: Dashboard shows no-openspec detail
- **WHEN** no-OpenSpec workflow is in implementation
- **THEN** UI SHALL show worker run, configured runtime/profile, and no planner/OpenSpec tasks
- **AND** UI SHALL not infer type from module list

### Requirement: New-workflow catalog describes no-openspec
The new-workflow modal SHALL retain `quick` as the selectable alias that starts the `no-openspec` definition and SHALL show the `No OpenSpec` label plus a description explaining that it supports repositories without OpenSpec and its apply, review, developer-review, wiki, and wiki-review phases.

#### Scenario: Quick alias starts no-openspec
- **WHEN** a user selects the quick/no-OpenSpec workflow and submits the wizard
- **THEN** dashboard startup SHALL pass `no-openspec` to the workflow engine
- **AND** the modal SHALL not display any parenthesized text in labels, options, or workflow display values
