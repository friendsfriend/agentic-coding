## MODIFIED Requirements

### Requirement: Default workflow type preserves existing behavior
The system SHALL default start to the pinned `openspec-full` definition when no workflow definition is supplied. The default SHALL be based on the request, not inferred or repaired from historical workflow state.

#### Scenario: Default start is standard
- **WHEN** a developer starts a new workflow without `--workflow`
- **THEN** the engine SHALL validate the `openspec-full` definition and begin a planning run
- **AND** it SHALL not infer a workflow type from repository artifacts, modules, or phases
