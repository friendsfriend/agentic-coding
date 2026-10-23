## ADDED Requirements

### Requirement: Tester records business process understanding
`stage.execute` SHALL keep testing the ticket with reviewed or newly authored blocks as the tester's only goal, and SHALL require the `stage-tester` to read the matching process concept before testing when one exists. The report's `knowledgeObservations` SHALL document the reusable business understanding learned while walking the process, with each observation classified as `new`, `confirmed`, `contradicted` or `missing` and supported by a journal entry. Business understanding includes the process purpose, actors, ordered steps, decisions, inputs, outputs, rules and system behavior on submit. UI quirks and selector or timing trouble SHALL be findings, not process knowledge. The tester SHALL summarize confirmed facts only as needed to explain a change or gap, rather than repeat them at length. When no process concept exists, the tester SHALL record at least one `new` observation for each process step it learned; unresolved business information MAY be recorded as `missing`. When a block implements a process step, the tester SHALL include its block ID in the existing observation or journal wording when the association is supported by the run evidence; it SHALL NOT invent a block-to-step association or change the report schema for this purpose.

#### Scenario: Undocumented process steps are recorded as new knowledge
- **WHEN** the tester finds no process concept and learns that an applicant submits a connection request, an operator reviews it, and a decision is returned
- **THEN** the report SHALL contain at least one `new` observation for each of those learned steps, with business details supported by the journal

#### Scenario: Existing process knowledge is read and extended concisely
- **WHEN** a process concept describes the submission and review steps and the tester confirms them while learning a new decision rule
- **THEN** the tester SHALL read that concept before testing, record the new rule and any material confirmations, and SHALL NOT restate the confirmed steps at length

#### Scenario: UI friction remains a finding
- **WHEN** the tester encounters a selector timeout or an unexpected layout while testing a business step
- **THEN** it SHALL record that behavior as a finding and SHALL NOT treat it as business-process knowledge

#### Scenario: Block reference is grounded in the run
- **WHEN** a reviewed block clearly implements a documented process step
- **THEN** the observation or journal wording SHALL name that block ID for the step, and an unsupported association SHALL be omitted

## MODIFIED Requirements

### Requirement: Report review, follow-ups and close
`stage.review` SHALL present the report for developer review with line comments and SHALL offer `approve-review` (→ `core.completed`, promoting the drafts the report claims), `approve-and-update-wiki` (→ `core.wiki`, promoting them as well, offered whenever the report has at least one knowledge observation) and a follow-up comment (→ `stage.execute` with the comment, at most 3 rounds, keeping the drafts). A draft the report does not claim SHALL never be published. The review SHALL make each created or adjusted block and its recorded proof visible in the rendered report, and both approval labels SHALL name how many blocks they promote. For a confirmed-only observation list, the wiki action label SHALL state that no wiki changes are expected. Untrusted values interpolated into report Markdown SHALL be escaped and line breaks flattened so report data cannot change the Markdown structure. Closing the workflow SHALL stop its browser sessions, release its stage lease and remove its drafts.

#### Scenario: Follow-up
- **WHEN** the developer submits a comment asking to also test the rejection path
- **THEN** the workflow SHALL return to `stage.execute` with the comment in the assignment and the drafts intact

#### Scenario: Approve without wiki work
- **WHEN** the developer chooses `approve-review`
- **THEN** the workflow SHALL move to `core.completed` without a wiki step and the approved blocks SHALL be promoted before or at completion

#### Scenario: Confirmed observations still allow wiki review
- **WHEN** the report contains one or more knowledge observations and every observation is `confirmed`
- **THEN** `approve-and-update-wiki` SHALL be offered alongside `approve`, choosing it SHALL route to `core.wiki`, and its label SHALL say no wiki changes are expected while retaining the promoted-block count

#### Scenario: Untrusted report content cannot alter Markdown structure
- **WHEN** a report field contains newlines and Markdown syntax such as a heading or link
- **THEN** the rendered report SHALL keep that value on one escaped text line and SHALL NOT create a new heading, list item or link from it

#### Scenario: No observations do not offer wiki review
- **WHEN** the report contains no knowledge observations
- **THEN** `approve-and-update-wiki` SHALL NOT be offered and `approve` SHALL remain available

#### Scenario: Review shows the authored blocks
- **WHEN** the report lists one created block
- **THEN** the review SHALL show that block's postcondition, operations and proof and the approval SHALL be labelled with the number of blocks it promotes

#### Scenario: Wiki approval promotes the claimed blocks
- **WHEN** the current stage-test definition reaches `stage.review` with claimed block drafts and the developer chooses `approve-and-update-wiki`
- **THEN** the same block-promotion effect used by `approve` SHALL run before `core.wiki`, and the action label SHALL state the promoted-block count
