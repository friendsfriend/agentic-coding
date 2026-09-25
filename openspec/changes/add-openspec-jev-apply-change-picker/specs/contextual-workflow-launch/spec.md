## ADDED Requirements

### Requirement: Existing-change workflow types use discovered change selection
The contextual creation form SHALL present the discovered OpenSpec changes of
the selected repository as the workflow-id choices for every workflow type that
applies a pre-existing change, including `openspec-apply` and
`openspec-jev-apply`. For those types the form SHALL fetch the change list from
the same backend boundary and SHALL submit the selected change id as the
workflow id. Task-driven types SHALL keep the free-text workflow-id input.

#### Scenario: JEV apply selects a discovered change
- **WHEN** the user selects the `openspec-jev-apply` workflow type for a repository containing OpenSpec changes
- **THEN** the workflow-id step SHALL render the repository's discovered change ids as a selectable list
- **AND** submitting the form SHALL use the selected change id as the workflow id with workflow type `openspec-jev-apply`

#### Scenario: Non-apply types keep the free-text workflow id
- **WHEN** the user selects `openspec-jev` in the new-workflow form
- **THEN** the workflow-id step SHALL remain a free-text input rather than a discovered change list
