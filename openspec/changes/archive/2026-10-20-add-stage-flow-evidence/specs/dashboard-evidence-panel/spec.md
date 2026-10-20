## ADDED Requirements

### Requirement: Flow grouping in the evidence panel
When a workflow has a stage step journal, the evidence panel SHALL group its entries by flow segment in journal order, show under each segment the journal steps that referenced it with their label, application, role and `mm:ss` offset, and list entries referenced by no segment in a trailing group. It SHALL offer an action that opens the workflow's `stage-flow.html` with the system opener; the action SHALL be declared in the panel's keybind catalog. Workflows without a journal SHALL keep the existing panel.

#### Scenario: Grouped flow
- **WHEN** the selected workflow has a journal with two kept segments
- **THEN** the panel SHALL show two segment groups with their steps and offsets, followed by unreferenced entries

#### Scenario: Open the flow page
- **WHEN** the developer triggers the open-flow action
- **THEN** the system opener SHALL be invoked with the workflow's `stage-flow.html`

#### Scenario: Workflow without journal
- **WHEN** the selected workflow has no journal
- **THEN** the panel SHALL render exactly as before and SHALL NOT offer the open-flow action
