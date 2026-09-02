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
