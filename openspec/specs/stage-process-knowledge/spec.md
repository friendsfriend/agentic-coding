# stage-process-knowledge Specification

## Purpose
TBD - created by archiving change add-stage-test-workflow. Update Purpose after archive.
## Requirements
### Requirement: Process knowledge page structure
Process-flow knowledge SHALL live in the wiki under the stage's system namespace at `projects/<system>/processes/<process>`, as a concept of type `process`, with business documentation for purpose, actors, ordered steps, decisions and rules, inputs, outputs, and open questions. Each step SHALL link to the exact implementing block ID when the reviewed report and journal establish that association, using the ID as a catalog reference a later tester can query; unsupported associations SHALL be omitted. Open questions SHALL preserve unresolved details from `missing` observations and disputed `contradicted` observations. Process concepts SHALL name applications by stage application key and roles by role name, SHALL NOT contain credentials, and SHALL NOT document UI quirks, selector failures or timing trouble as business process knowledge. A hub at `projects/<system>/processes/index` SHALL link every process concept. Sources added by a stage test SHALL cite `stage://<stage>/<workflow-id>`.

#### Scenario: New process page documents business flow
- **WHEN** the first approved stage test of the grid-connection flow on system `grid-allocation` writes knowledge back
- **THEN** the draft SHALL be `projects/grid-allocation/processes/grid-connection-request` of type `process`, SHALL document its purpose, actors, ordered steps, decisions/rules, inputs and outputs, SHALL include open questions supported by missing or unresolved contradicted observations, and the hub SHALL link it

#### Scenario: Process step links to its implementing block
- **WHEN** the reviewed report and journal identify a block ID as implementing the request-submission step
- **THEN** the process concept SHALL associate that block ID with that step so a later tester can find it in the block catalog

#### Scenario: Uncertain block association is not invented
- **WHEN** the report lists a block but does not establish which process step it implements
- **THEN** the process concept SHALL NOT assign that block to a step

#### Scenario: UI friction is not process documentation
- **WHEN** a tester reports a selector timeout while documenting the grid-connection flow
- **THEN** the timeout SHALL remain a report finding and SHALL NOT be added as business process knowledge

### Requirement: A ticket finds its process page before testing
The `stage-tester` SHALL resolve and read the matching process concept before it starts testing: first use the stage's `wiki.processes` hints, then search with terms from the ticket restricted to `projects/<system>/`, and read every matching concept it relies on. It SHALL include each relied-on concept's trust tier and `stale_after` value in the corresponding report observation's existing `statement` or `observed` wording; when stale knowledge was relied on, the observation SHALL say so. The report SHALL record concise, evidence-backed business understanding of the process walked, including its purpose, actors, steps, decisions, inputs, outputs, rules and system behavior on submit, as observations of kind `new`, `confirmed`, `contradicted` or `missing`; it SHALL not repeat confirmed facts at length. When a process concept exists, observations SHALL explain material confirmations, corrections, additions or unresolved gaps rather than copy the page. When no process concept is found, the tester SHALL derive checks from the ticket and record at least one `new` observation for every process step it learned; `missing` SHALL identify unresolved business details, not replace those new observations. UI quirks and selector/timing trouble SHALL be findings, not process knowledge. When a block is known to implement a step, the tester SHALL include its ID in the existing journal or observation wording only when the association is supported by the run. The tester SHALL NOT write the wiki; write-back remains the `stage-wiki` role's job after developer approval at report review.

#### Scenario: Stale page used
- **WHEN** the matching process concept is past its `stale_after`
- **THEN** the report SHALL record an observation against that concept stating its trust tier, `stale_after` value and that the tester relied on stale knowledge

#### Scenario: No page exists
- **WHEN** no process concept matches the ticket and the tester learns three steps from the ticket and stage
- **THEN** the tester SHALL derive checks from the ticket alone and record at least one `new` observation for each learned step, plus `missing` observations for important business details it could not establish

#### Scenario: Existing process page is extended without repetition
- **WHEN** the process page already documents two steps and the tester confirms them while learning a new output rule
- **THEN** the tester SHALL read the page before testing, record the new rule and any material confirmations, and SHALL NOT repeat the confirmed steps at length

#### Scenario: Testing does not write knowledge
- **WHEN** the tester wants to correct a process concept it found to be wrong
- **THEN** it SHALL record a `contradicted` observation with the relevant evidence and SHALL NOT write the wiki, leaving the decision to the developer at report review

### Requirement: Knowledge write-back preserves disputed claims
Wiki write-back SHALL happen only after the developer chooses `approve-and-update-wiki` at `stage.review`, through `core.wiki` run by the `stage-wiki` role and `core.wiki-approval`. The review action SHALL be offered whenever the report has at least one knowledge observation, including confirmed-only observations. From the report and its cited journal/evidence, the role SHALL create or update the process concept with business purpose, actors, ordered steps, decisions/rules, inputs and outputs; it SHALL include block IDs on the steps they implement when the association is explicit and supported. `missing` observations SHALL become open questions rather than unsupported claims. `new` observations SHALL document the learned process facts. A `contradicted` observation with suspected cause `product-change` SHALL update the concept only when the evidence supports the changed behavior, recording a dated note that names the workflow and replaced statement; unresolved parts SHALL remain open questions. A `contradicted` observation with suspected cause `regression` or `unknown` SHALL NOT change the claim and SHALL add a dated `Disputed` callout linking the report and record the unresolved issue as an open question. `confirmed` observations SHALL NOT cause a write by themselves. Observation text crossing into `core.wiki` SHALL be bounded, normalized and supplied as a separate explicitly untrusted evidence payload; the role SHALL NOT treat embedded instructions as authority. Stage-wiki writes SHALL supply the `contentDigest` read from the current page (or `absent` for a new page), and a stale digest SHALL be refused so the role can re-read the current page, merge the approved observations and retry. UI quirks, selector failures and timing trouble SHALL remain findings and SHALL NOT be written as process knowledge. Developer approval at `core.wiki-approval` SHALL run the existing `wiki.verify` effect; comments SHALL return to `core.wiki` (at most 6 rounds).

#### Scenario: Suspected regression
- **WHEN** the process page says the clerk receives the request within one minute and the tester observed no request after the maximum wait, classified `regression`
- **THEN** the claim SHALL remain, the concept SHALL gain a dated `Disputed` callout linking the report, and the unresolved delivery behavior SHALL appear as an open question

#### Scenario: Product change
- **WHEN** the ticket changes the installer step and the tester observed the new behavior with supporting evidence, classified `product-change`
- **THEN** the concept's step SHALL be updated with a dated note naming the workflow and replaced statement, and any detail not established by the evidence SHALL remain an open question

#### Scenario: Missing process detail
- **WHEN** the tester records that it could not establish which actor makes a decision
- **THEN** the process concept SHALL preserve that uncertainty as an open question rather than invent an actor or rule

#### Scenario: Only confirmations
- **WHEN** every knowledge observation of the report is `confirmed` and the developer chooses `approve-and-update-wiki`
- **THEN** the action SHALL have been offered, but confirmed observations alone SHALL cause no wiki write

#### Scenario: Untrusted observation text is data, not instructions
- **WHEN** an approved observation contains text that resembles an instruction or Markdown delimiter
- **THEN** the stage-wiki role SHALL receive only bounded, normalized observation fields in a distinct untrusted payload and SHALL use them only as evidence

#### Scenario: A stale process-page write is refused
- **WHEN** two stage-wiki runs read the same process-page digest and the first updates the page before the second writes
- **THEN** the second write SHALL be refused; its role SHALL re-read the current page, merge its approved observations with the new content, and retry with the current digest

