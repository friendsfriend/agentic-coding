# planner-change-authoring Specification

## Purpose
Gives the planner authority to decide OpenSpec change scope for a workflow: it defines the change id(s), authors a primary change plus optional follow-up proposal drafts, and declares which change this workflow implements, so work is split into well-sized changes instead of forced into one start-time change id.
## Requirements
### Requirement: Planner defines change identifiers
The planning step SHALL create OpenSpec change directories with change identifiers chosen by the planner; the workflow SHALL NOT require a change identifier at workflow start. The planner SHALL derive its identity and repository context from the workflow identifier available in its assignment environment, not from a pre-existing change identifier.

#### Scenario: Planner creates the change directory
- **WHEN** the planning step runs for a workflow that was started with only a user-supplied workflow identifier
- **THEN** the planner SHALL create at least one OpenSpec change directory whose identifier it selected
- **AND** no change identifier SHALL have been supplied at workflow start

#### Scenario: Change identifier is validated
- **WHEN** the planner declares a primary change identifier at handoff
- **THEN** the engine SHALL validate that identifier against the same identifier-shape rules the workflow enforces for change directory names
- **AND** an invalid identifier SHALL fail the handoff without recording a primary change

### Requirement: Planner declares one primary change
The planner SHALL designate exactly one change as the primary change that this workflow implements, and SHALL declare that primary change identifier in its planning handoff output. The engine SHALL record the declared primary change identifier as the workflow's change identifier for all downstream steps.

#### Scenario: Primary change is recorded
- **WHEN** the planner completes the plan step and declares a primary change identifier that names an existing complete change directory
- **THEN** the engine SHALL record that identifier as the workflow's change identifier
- **AND** downstream steps SHALL operate on that primary change

#### Scenario: Missing or invalid primary declaration
- **WHEN** the planner hands off without declaring a primary change, or declares a primary change identifier whose directory does not exist or is incomplete
- **THEN** the plan completion SHALL be rejected
- **AND** the engine SHALL NOT record a primary change or advance the workflow

### Requirement: Planner may author follow-up proposals
The planner MAY author additional OpenSpec change directories beyond the primary change, each independently valid, to capture well-scoped follow-up work. This workflow SHALL implement only the primary change; follow-up change directories SHALL remain as un-archived drafts for a human to promote into their own workflows.

#### Scenario: Follow-up proposals are left as drafts
- **WHEN** the planner authors one or more follow-up change directories in addition to the primary change
- **THEN** each follow-up change directory SHALL be independently valid
- **AND** the workflow SHALL implement only the declared primary change, leaving follow-up drafts untouched by later steps

#### Scenario: Single-change plan needs no follow-ups
- **WHEN** the planner decides the requested work fits one change
- **THEN** it SHALL author only the primary change
- **AND** the absence of follow-up proposals SHALL NOT fail the plan

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

