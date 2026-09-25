# contextual-workflow-launch Specification

## Purpose
TBD - created by archiving change launch-workflows-from-project-and-wiki-pages. Update Purpose after archive.

## Requirements

### Requirement: Repository launch starts from its resource page
Application and library pages SHALL offer Start workflow using their configured stable project identity. Repository-related workflows, including research and wiki workflows, SHALL start there rather than from Wiki or a global workflow picker. Forms SHALL retain supported task/type/preset/checkout options without repository, custom-path or independent-target selectors. The backend SHALL revalidate project availability, capability and authorization at submission.

#### Scenario: Start for a library
- **WHEN** the user starts a repository-related workflow from a selected library
- **THEN** creation SHALL use that library's canonical identity and explicitly selected supported checkout behavior without asking for another repository

#### Scenario: Project becomes unavailable
- **WHEN** the configured project is removed or loses its checkout before submission
- **THEN** the start SHALL fail with an actionable error without scanning, cloning or substituting a repository

### Requirement: Independent work starts from Wiki
Wiki SHALL offer repository-independent research and wiki creation, including existing wiki-comment review submission, without requiring a project catalog entry. Wiki SHALL NOT provide repository selection or launch repository-bound work. Existing registry-driven workflow and target semantics SHALL remain authoritative.

#### Scenario: Empty catalog
- **WHEN** no applications or libraries are configured
- **THEN** independent research/wiki starts and wiki review submission SHALL remain available from Wiki

#### Scenario: Research about a repository
- **WHEN** the user wants a repository-bound research workflow
- **THEN** its launch entry SHALL be on that application's or library's page rather than in the Wiki creation form

### Requirement: Herdr owns workflow workspace access
Successful contextual creation SHALL use existing Herdr workspace/dashboard handoff while retaining the originating full-application page. Creation SHALL use the existing authenticated start boundary, preserve durable request/retry semantics and prevent concurrent duplicate submission. A post-acceptance handoff failure SHALL be distinguished from a rejected start and SHALL NOT trigger duplicate creation.

#### Scenario: Successful start
- **WHEN** workflow creation succeeds
- **THEN** the existing Herdr orchestration SHALL own workspace access and the full application SHALL show a bounded result without entering a workflow detail route

#### Scenario: Handoff fails after acceptance
- **WHEN** a workflow has been durably accepted but Herdr handoff fails
- **THEN** the UI SHALL identify the accepted workflow and failure and use existing repair/reconciliation semantics rather than submit another workflow

### Requirement: No workflow browser or reopen surface
The full application SHALL NOT expose a Workflows destination, global or project-local workflow lists, history/recent lists, active-workflow dashboard launchers or closed-workflow reopen actions. Removing those surfaces SHALL NOT delete durable workflow data or remove explicit CLI targeting, Herdr integration, authorization or recovery contracts.

#### Scenario: Workspace closes
- **WHEN** a Herdr-managed workflow workspace is closed
- **THEN** the full application SHALL NOT create a recent/history/reopen entry for it
- **AND** closure and durable cleanup SHALL continue to follow existing backend semantics rather than UI navigation

### Requirement: Task-driven workflow types expose the task input
The contextual creation form SHALL render and submit a task input for every
registry workflow type whose planner is steered by a user task, including
`openspec` and the fusion workflow types. The form SHALL NOT silently omit the
task step for a task-driven type. Workflow types that select an existing
OpenSpec change instead of accepting a task SHALL keep their current task-free
field set, and the checkout behavior of each type SHALL NOT change.

#### Scenario: JEV workflow offers and submits a task
- **WHEN** the user selects the classifier-routed `openspec` workflow type in the new-workflow form
- **THEN** the wizard SHALL present a task input step before the checkout mode step
- **AND** the submitted launch input SHALL carry the entered task text with workflow type `openspec`

#### Scenario: Existing-change workflows stay task-free
- **WHEN** the user selects `openspec-apply` in the new-workflow form
- **THEN** the wizard SHALL continue to omit the task step and submit the launch input without a task

### Requirement: Classifier-routed workflow catalog exposure

The contextual creation form and the CLI workflow catalog SHALL expose the
registered classifier-routed family: `openspec`, `openspec-apply`,
`openspec-propose`, `openspec-fusion`, and `openspec-fusion-propose`, alongside
the unchanged `no-openspec`, `wiki`, and `research` types. Removed identifiers
SHALL NOT be offered.

#### Scenario: Form lists the current OpenSpec family
- **WHEN** the user opens the new-workflow form
- **THEN** the offered OpenSpec workflow types SHALL be `openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`, and `openspec-fusion-propose`
- **AND** removed identifiers SHALL NOT be selectable

#### Scenario: Apply uses the discovered change picker
- **WHEN** the user selects `openspec-apply` for a repository containing OpenSpec changes
- **THEN** the workflow-id step SHALL render the repository's discovered change ids as a selectable list
- **AND** submitting the form SHALL use the selected change id as the workflow id

#### Scenario: Removed type is not offered
- **WHEN** the form is rendered after the removed definitions are unregistered
- **THEN** `openspec-full`, `openspec-jev`, and `openspec-jev-apply` SHALL NOT appear as selectable workflow types
