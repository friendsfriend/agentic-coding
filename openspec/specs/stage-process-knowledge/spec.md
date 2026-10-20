# stage-process-knowledge Specification

## Purpose
TBD - created by archiving change add-stage-test-workflow. Update Purpose after archive.
## Requirements
### Requirement: Process knowledge page structure
Process-flow knowledge SHALL live in the wiki under the stage's `system` namespace: `projects/<system>/processes/<process>` concepts of type `process` with the sections Covers, Actors & apps, Steps, Hand-overs, Asynchronous steps, Test data, Assertions that matter and Gotchas; `projects/<system>/stages/<stage>` concepts of type `stage-notes` for non-secret stage quirks; and a hub `projects/<system>/processes/index` linking every process concept. Process concepts SHALL name applications by stage application key and roles by role name and SHALL NOT contain credentials. Sources added by a stage test SHALL cite `stage://<stage>/<workflow-id>`.

#### Scenario: New process page
- **WHEN** the first approved stage test of the grid-connection flow on system `grid-allocation` writes knowledge back
- **THEN** the draft SHALL be `projects/grid-allocation/processes/grid-connection-request` of type `process` with the defined sections, and the hub SHALL link it

### Requirement: A ticket finds its process page before testing
The `stage-planner` SHALL resolve process knowledge before writing the plan: first the stage's `wiki.processes` hints, then a wiki search with terms from the ticket restricted to `projects/<system>/`. The plan SHALL list every concept it used with its trust tier and whether it is past `stale_after`; when none is found the plan SHALL say so and derive the route from the ticket alone, and the tester SHALL record `missing` knowledge observations for the steps it discovers.

#### Scenario: Stale page used
- **WHEN** the matching process concept is past its `stale_after`
- **THEN** the plan SHALL list it as stale and the report SHALL show that the route relied on stale knowledge

#### Scenario: No page exists
- **WHEN** no process concept matches the ticket
- **THEN** the plan SHALL state that no process knowledge was found

### Requirement: Knowledge write-back preserves disputed claims
Wiki write-back SHALL happen only after the developer chooses approve-and-update-wiki at `stage.review`, through `core.wiki` run by the `stage-wiki` role and `core.wiki-approval`. The role SHALL work from the report's knowledge observations: `missing` and `new` observations and `contradicted` observations with suspected cause `product-change` SHALL update the concept, recording a dated note that names the workflow and the replaced statement; `contradicted` observations with suspected cause `regression` or `unknown` SHALL NOT change the claim and SHALL add a dated "Disputed" callout linking the report; `confirmed` observations SHALL NOT cause a write. Developer approval at `core.wiki-approval` SHALL run the existing `wiki.verify` effect; comments SHALL return to `core.wiki` (at most 6 rounds).

#### Scenario: Suspected regression
- **WHEN** the process page says the clerk receives the request within one minute and the tester observed no request after the maximum wait, classified `regression`
- **THEN** the claim SHALL remain and the concept SHALL gain a dated "Disputed" callout linking the report

#### Scenario: Product change
- **WHEN** the ticket changes the installer step and the tester observed the new behaviour, classified `product-change`
- **THEN** the concept's step SHALL be updated with a dated note naming the workflow and the replaced statement

#### Scenario: Only confirmations
- **WHEN** every knowledge observation of the report is `confirmed`
- **THEN** approve-and-update-wiki SHALL NOT be offered and no wiki write SHALL occur

