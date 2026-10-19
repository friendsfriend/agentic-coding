## ADDED Requirements

### Requirement: The planner works under an exploratory budget

The pinned planning instruction SHALL state an exploratory budget: the planner
SHALL create the change directory and write a skeleton of the first artifact as
soon as it knows the change's identifier and intent, then extend each artifact in
place as it learns, rather than reading the whole domain surface first. It SHALL
bound exploration to the change's own surface — the files the plan creates or
changes and their direct dependencies — and SHALL carry into `openQuestions` what
it cannot settle rather than reading further to settle it. The budget SHALL bound
exploration only: the instruction SHALL still require the planner to read every
dependency artifact from disk before writing the one that depends on it, and
SHALL NOT relax the validation, capability or impact the artifacts must carry.

#### Scenario: The skeleton exists before the domain is fully explored

- **WHEN** the planning step's instruction is rendered into an assignment
- **THEN** it SHALL direct the planner to create the change directory and a skeleton of the first artifact early and extend it in place

#### Scenario: Exploration is bounded, the required reads are not

- **WHEN** the planning instruction is rendered
- **THEN** it SHALL state both the exploratory budget and the unchanged rule that each dependency artifact is read from disk before the dependent one is written

#### Scenario: Unsettled questions do not extend the reading loop

- **WHEN** the planner cannot settle a question from the change's own surface within the budget
- **THEN** the instruction SHALL direct it to record the question in the plan's `openQuestions` instead of continuing to explore

### Requirement: The plan artifact declares the plan's file list

The plan artifact SHALL declare the plan's file list: the repository-relative
paths the plan creates or changes, including the change's own artifact files, so
a later step can be handed that list without reading the change's documents. The
planning instruction SHALL state that meaning for the plan's existing file-list
field, and the engine SHALL forward the declared list to the implementation
step's assignment. The declaration SHALL use the field the plan artifact already
carries: the workflow SHALL NOT require a new plan field, a snapshot schema
change, a migration, or a separately persisted file list.

#### Scenario: The plan names its files

- **WHEN** a plan is authored for a change that creates or edits repository files
- **THEN** its plan artifact SHALL declare those paths as the plan's file list, in addition to the change's own artifact paths

#### Scenario: A plan declaring no files stays valid

- **WHEN** the plan artifact declares no paths
- **THEN** the plan completion SHALL be unaffected and the implementation assignment SHALL render no plan-file input

#### Scenario: The list is not read out of the change documents

- **WHEN** a later step's assignment needs the plan's files
- **THEN** the engine SHALL take them from the recorded plan artifact's declared list and SHALL NOT parse the change's `tasks.md`, `design.md` or spec files for paths
