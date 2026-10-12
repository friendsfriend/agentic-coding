## MODIFIED Requirements

### Requirement: One decision record per answered classifier question

When a classifier effect completes, the workflow SHALL retain one decision record per answered question of that request, in request order. Each record SHALL carry the classifier integration that produced it, the asked question's identifier, the classifier model, the classifier input, the options that were offered (each with its label, the profile it names, and its criteria), the model's answer (its type, chosen label, confidence and probabilities), and the result (whether the answer was applied, the profiles applied, and any attention note). A question the classifier did not answer SHALL still be recorded, with its no-answer type and the fallback result. Model selection SHALL NOT produce a decision record: a step's model is resolved and pinned at workflow start rather than chosen by a classifier.

#### Scenario: Verifier-role classification records one record per question

- **WHEN** a verifier-role classification completes for a round that asked three eligible roles
- **THEN** the workflow SHALL hold one decision record per asked role question
- **AND** each record's options SHALL be that question's own identifiers

#### Scenario: Gate classification records its decision

- **WHEN** a stage gate's classification completes
- **THEN** a decision record SHALL exist for that stage's question
- **AND** its result SHALL record whether the answer was applied

#### Scenario: Unanswered question is recorded with its fallback

- **WHEN** a classifier call completes and the classifier returned no usable answer for a question
- **THEN** a decision record SHALL exist for that question
- **AND** its answer type SHALL be the no-answer type
- **AND** its result SHALL record that the answer was not applied

#### Scenario: Model selection leaves no classifier record

- **WHEN** a workflow starts with an Orchestrator-supplied per-step model selection and later runs its agent steps
- **THEN** no decision record SHALL be written for a model selection
- **AND** the workflow's decision history SHALL contain only triage, gate, and file-judgment records
