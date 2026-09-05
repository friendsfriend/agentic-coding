## ADDED Requirements

### Requirement: Dashboard feature and composition ownership
Dashboard review state and submission SHALL be owned by cohesive feature modules, while the root component owns composition, layout, and lifecycle wiring. Extracted features SHALL use explicit inputs and existing Solid ownership rather than a new global state store or an unrestricted root context.

#### Scenario: Review is submitted
- **WHEN** a plan, developer, or wiki review is submitted through an extracted feature
- **THEN** it SHALL produce the same validated payload with the displayed engine action ID and revision as before extraction
- **AND** the feature SHALL not infer new action availability from workflow or step identifiers

#### Scenario: Review is cancelled or component is disposed
- **WHEN** a review is cancelled or its owning component unmounts
- **THEN** draft, pending, focus, and cleanup behavior SHALL remain unchanged
- **AND** extracted reactive state SHALL not outlive its intended component ownership

### Requirement: Dashboard projections are separate from observation I/O
Dashboard projection helpers SHALL accept typed workflow views, observations, and artifact results as data and return display data without filesystem, Git, Herdr, database, network, or ambient clock access. External observation collection SHALL remain in separate I/O modules using the established asynchronous execution boundary.

#### Scenario: Projection is evaluated deterministically
- **WHEN** a projection receives identical workflow, observation, artifact, and explicit time inputs
- **THEN** it SHALL return equivalent display data without performing external reads or starting execution

#### Scenario: Observation is missing or invalid
- **WHEN** an observation or artifact result is missing, stale, or fails its existing integrity checks
- **THEN** projections SHALL preserve the current diagnostic/display behavior
- **AND** observation presence SHALL not be treated as authoritative workflow completion

#### Scenario: Extraction changes module paths
- **WHEN** review and projection code moves out of App.tsx or data.ts
- **THEN** existing action, revision, navigation, review, and renderer acceptance tests SHALL continue to pass
- **AND** the move SHALL not change persisted state, definition pins, or execution scheduling ownership
