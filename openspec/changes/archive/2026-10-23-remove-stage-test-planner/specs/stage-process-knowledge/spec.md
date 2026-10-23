## MODIFIED Requirements

### Requirement: A ticket finds its process page before testing
The `stage-tester` SHALL resolve process knowledge before it starts testing: first the stage's
`wiki.processes` hints, then a wiki search with terms from the ticket restricted to
`projects/<system>/`. It SHALL read every matching concept it relies on and SHALL account for
`stale_after`. The report SHALL record, for every concept the run relied on, a knowledge observation
with its trust tier and whether it is stale; when no process knowledge is found the tester SHALL
derive the checks from the ticket alone and record `missing` knowledge observations for what it had to
discover itself. The tester SHALL NOT write the wiki: write-back remains the `stage-wiki` role's job
after the developer approves with approve-and-update-wiki.

#### Scenario: Stale page used
- **WHEN** the matching process concept is past its `stale_after`
- **THEN** the report SHALL record that observation against that concept and show that the tester
  relied on stale knowledge

#### Scenario: No page exists
- **WHEN** no process concept matches the ticket
- **THEN** the tester SHALL derive the checks from the ticket alone and SHALL record `missing`
  knowledge observations for the steps it discovered

#### Scenario: Testing does not write knowledge
- **WHEN** the tester wants to correct a process concept it found to be wrong
- **THEN** it SHALL record a `contradicted` observation and SHALL NOT write the wiki, leaving the
  decision to the developer at report review
