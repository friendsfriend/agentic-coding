# Spec Delta

## ADDED Requirements

### Requirement: Classifier routing events group under one trace-tree category

The trace tree SHALL group the classifier-routing telemetry events under a
single stable category node so that every routing pass and its records are
collapsible as one group inside a workflow trace, and SHALL render one span per
routing event with the event name, layer, duration when reported, and all
attributes, exactly as it does for engine, adapter, and runtime events.

#### Scenario: Routing pass records group in the tree

- **WHEN** the developer opens the trace tree of a workflow that ran classifier
  routing
- **THEN** the routing pass events SHALL appear grouped under one category node
- **AND** each record SHALL be selectable with its attributes and duration
  visible

#### Scenario: Unknown families keep their own name

- **WHEN** a telemetry event family is not in the category catalog
- **THEN** the viewer SHALL group it under a node named after that family
- **AND** it SHALL NOT drop the event
